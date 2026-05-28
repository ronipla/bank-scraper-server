const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createScraper, CompanyTypes } = require('israeli-bank-scrapers');

puppeteer.use(StealthPlugin());

// ── Failure screenshot capture (DIAGNOSTIC, opt-in) ──
// When a scrape fails, we don't know WHAT the bank showed (locked? wrong creds?
// terms popup? CAPTCHA?). The `errorType` alone (e.g. AUTH_FAILURE) can't
// distinguish "wrong password" from "account locked" — both surface the same.
// This grabs the live page and uploads it to a TEMPORARY anonymous host so it
// can be inspected, WITHOUT writing to a disk we can't read.
//
// Gated by CAPTURE_FAILURE_SCREENSHOTS=1 so it stays OFF in normal operation —
// a screenshot of a logged-in bank page is sensitive. The login page that an
// AUTH_FAILURE produces shows no account data, only the bank's error message.
const CAPTURE_FAILURE_SCREENSHOTS = process.env.CAPTURE_FAILURE_SCREENSHOTS === '1';

// Upload a PNG buffer to tmpfiles.org (anonymous, auto-expires ~1h). Returns the
// direct URL or null. Best-effort — never throws into the scrape path.
async function uploadScreenshot(pngBuffer, company) {
  try {
    const form = new FormData();
    const blob = new Blob([pngBuffer], { type: 'image/png' });
    form.append('file', blob, `fail-${company}-${Date.now()}.png`);
    const resp = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form });
    if (!resp.ok) {
      console.warn(`[${company}] screenshot upload failed: HTTP ${resp.status}`);
      return null;
    }
    const json = await resp.json();
    // tmpfiles returns a viewer URL like https://tmpfiles.org/12345/name.png;
    // the direct-download form is https://tmpfiles.org/dl/12345/name.png
    const url = json?.data?.url || null;
    return url ? url.replace('tmpfiles.org/', 'tmpfiles.org/dl/') : null;
  } catch (err) {
    console.warn(`[${company}] screenshot upload error: ${err.message}`);
    return null;
  }
}

// Read a screenshot file the LIBRARY wrote (via storeFailureScreenShotPath) and
// upload it. The library captures its OWN page (this.page — the real bank login
// page) at the moment login fails, BEFORE tearing it down. That's the page we
// actually want — earlier we screenshotted browser.pages().last() which, after
// the library closed its page, was a leftover about:blank tab. Best-effort.
async function uploadScreenshotFile(filePath, company) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[${company}] failure screenshot not found at ${filePath} (login may have failed before page render)`);
      return null;
    }
    const buf = fs.readFileSync(filePath);
    const link = await uploadScreenshot(buf, company);
    console.warn(`[${company}] FAILURE SCREENSHOT (library-captured page) — url=${link || '(upload failed)'} | bytes=${buf.length}`);
    try { fs.unlinkSync(filePath); } catch { /* ignore cleanup */ }
    return link;
  } catch (err) {
    console.warn(`[${company}] could not read/upload failure screenshot: ${err.message}`);
    return null;
  }
}

// ── Deterministic fingerprint per org ──
// Same orgId always gets the same profile — consistent identity like a real user.
// 3 mainstream profiles only — blend into the crowd, don't stand out.
const BROWSER_PROFILES = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
];

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getFingerprintForOrg(orgId) {
  const seed = parseInt(crypto.createHash('sha256').update(String(orgId)).digest('hex').slice(0, 8), 16);
  const rng = mulberry32(seed);
  const profile = BROWSER_PROFILES[Math.floor(rng() * BROWSER_PROFILES.length)];
  return { ua: profile.ua, timezone: 'Asia/Jerusalem', language: 'he-IL' };
}

// Single source of truth for puppeteer.launch() options. Shared by performScrape
// AND the /health/browser watchdog endpoint so the health check exercises the
// EXACT same launch path the real scrape uses — if Chromium/puppeteer drift or a
// Docker lib goes missing, the watchdog catches it before a customer sync does.
// Leave executablePath undefined when PUPPETEER_EXECUTABLE_PATH is unset so
// puppeteer uses its own version-matched bundled Chromium (the closeTarget fix).
function buildLaunchOptions(orgId) {
  const fp = orgId
    ? getFingerprintForOrg(orgId)
    : { ua: BROWSER_PROFILES[0].ua, timezone: 'Asia/Jerusalem', language: 'he-IL' };
  return {
    options: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // --single-process / --no-zygote were REMOVED (2026-05-27): single-process
        // mode crashed the renderer target mid-navigation on heavy bank pages
        // ("Target.closeTarget"). Memory was never the constraint (~0.4GB peak).
        '--disable-blink-features=AutomationControlled',
        `--user-agent=${fp.ua}`,
        `--lang=${fp.language}`,
      ],
    },
    fp,
  };
}

const app = express();
const PORT = process.env.PORT || 3000;

// Credential fields that must never appear in logs or error reports.
// `callbackToken` is the Convex callback HMAC secret (SCRAPER_CALLBACK_SECRET) —
// it was previously logged via sanitizeForLog(req.body), leaking the secret to
// Railway logs. Redact it (and callbackUrl, which is internal infra).
const SENSITIVE_KEYS = new Set(['password', 'userCode', 'id', 'card6Digits', 'nationalID', 'apiPassword', 'username', 'num', 'callbackToken', 'callbackUrl']);

// Returns a shallow copy of obj with sensitive keys replaced — safe to log
function sanitizeForLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const key of SENSITIVE_KEYS) {
    if (key in out) out[key] = '[REDACTED]';
  }
  return out;
}

// No CORS: this is a backend-to-backend API (called only by Convex actions),
// never from a browser. Dropping the open `cors()` removes cross-origin exposure.
app.use(express.json());

// ── Inbound auth ──
// Operational routes require `Authorization: Bearer <SCRAPER_API_KEY>`. Without
// this, anyone who knows the URL could trigger scrape jobs (and point the
// callback at their own URL). `/` and `/health` stay public for Railway health
// checks.
//
// Rollout-safe by design: enforcement is ACTIVE only when SCRAPER_API_KEY is
// set. If it's unset, requests are allowed (current pre-auth behavior) — so
// deploying this code does NOT break sync before the env var exists. Sequence:
// (1) deploy this code (no enforcement yet), (2) set SCRAPER_API_KEY here AND on
// the Convex caller — enforcement then activates on both sides together. A
// loud startup warning makes the unprotected window visible.
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
if (!SCRAPER_API_KEY) {
  console.warn('⚠️  SCRAPER_API_KEY not set — /api routes are UNAUTHENTICATED. Set it (and the matching Convex env var) to enable inbound auth.');
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/health') return next();
  
  // Fail closed if the server is missing the key
  if (!SCRAPER_API_KEY) {
    console.error('CRITICAL: SCRAPER_API_KEY is not set. Refusing all API requests.');
    return res.status(500).json({ success: false, error: 'SERVER_MISCONFIGURED' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  }
  const token = authHeader.slice('Bearer '.length);
  if (!timingSafeEqualStr(token, SCRAPER_API_KEY)) {
    return res.status(403).json({ success: false, error: 'FORBIDDEN' });
  }
  next();
});

// Company configurations - what credentials each company needs
const COMPANY_CONFIG = {
  // Banks
  hapoalim: {
    companyId: CompanyTypes.hapoalim,
    name: 'בנק הפועלים',
    fields: ['userCode', 'password'],
    mapCredentials: (creds) => ({ userCode: creds.userCode, password: creds.password }),
  },
  leumi: {
    companyId: CompanyTypes.leumi,
    name: 'בנק לאומי',
    fields: ['username', 'password'],
    mapCredentials: (creds) => ({ username: creds.username, password: creds.password }),
  },
  discount: {
    companyId: CompanyTypes.discount,
    name: 'בנק דיסקונט',
    fields: ['id', 'password', 'num'],
    mapCredentials: (creds) => ({ id: creds.id, password: creds.password, num: creds.num }),
  },
  mizrahi: {
    companyId: CompanyTypes.mizrahi,
    name: 'בנק מזרחי',
    fields: ['username', 'password'],
    mapCredentials: (creds) => ({ username: creds.username, password: creds.password }),
  },
  mercantile: {
    companyId: CompanyTypes.mercantile,
    name: 'בנק מרכנתיל',
    fields: ['id', 'password', 'num'],
    mapCredentials: (creds) => ({ id: creds.id, password: creds.password, num: creds.num }),
  },
  otsarHahayal: {
    companyId: CompanyTypes.otsarHahayal,
    name: 'בנק אוצר החייל',
    fields: ['username', 'password'],
    mapCredentials: (creds) => ({ username: creds.username, password: creds.password }),
  },
  union: {
    companyId: CompanyTypes.union,
    name: 'בנק איגוד',
    fields: ['username', 'password'],
    mapCredentials: (creds) => ({ username: creds.username, password: creds.password }),
  },
  beinleumi: {
    companyId: CompanyTypes.beinleumi,
    name: 'הבנק הבינלאומי',
    fields: ['username', 'password'],
    mapCredentials: (creds) => ({ username: creds.username, password: creds.password }),
  },
  massad: {
    companyId: CompanyTypes.massad,
    name: 'בנק מסד',
    fields: ['username', 'password'],
    mapCredentials: (creds) => ({ username: creds.username, password: creds.password }),
  },
  yahav: {
    companyId: CompanyTypes.yahav,
    name: 'בנק יהב',
    fields: ['username', 'nationalID', 'password'],
    mapCredentials: (creds) => ({ username: creds.username, nationalID: creds.nationalID, password: creds.password }),
  },

  // Credit Cards
  visaCal: {
    companyId: CompanyTypes.visaCal,
    name: 'ויזה כאל',
    fields: ['username', 'password'],
    mapCredentials: (creds) => ({ username: creds.username, password: creds.password }),
  },
  max: {
    companyId: CompanyTypes.max,
    name: 'מקס (לאומי קארד)',
    fields: ['username', 'password'],
    mapCredentials: (creds) => ({ username: creds.username, password: creds.password }),
  },
  isracard: {
    companyId: CompanyTypes.isracard,
    name: 'ישראכרט',
    fields: ['id', 'card6Digits', 'password'],
    mapCredentials: (creds) => ({ id: creds.id, card6Digits: creds.card6Digits, password: creds.password }),
  },
  amex: {
    companyId: CompanyTypes.amex,
    name: 'אמריקן אקספרס',
    fields: ['id', 'card6Digits', 'password'],
    mapCredentials: (creds) => ({ id: creds.id, card6Digits: creds.card6Digits, password: creds.password }),
  },

  // Other
  beyahadBishvilha: {
    companyId: CompanyTypes.beyahadBishvilha,
    name: 'ביחד בשבילך',
    fields: ['id', 'password'],
    mapCredentials: (creds) => ({ id: creds.id, password: creds.password }),
  },
  behatsdaa: {
    companyId: CompanyTypes.behatsdaa,
    name: 'בהצדעה',
    fields: ['id', 'password'],
    mapCredentials: (creds) => ({ id: creds.id, password: creds.password }),
  },
};

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Bank scraper server is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Operational metrics — queue depth, active scrapes, uptime
app.get('/metrics', (req, res) => {
  res.json({
    queue: scrapeQueue.length,
    active: activeScrapes,
    uptime: process.uptime(),
  });
});

// ── Watchdog health endpoints (AUTHENTICATED — require SCRAPER_API_KEY) ──
// These power the cloud watchdog (GitHub Actions). They are NOT in the public
// whitelist (only `/` and `/health` are) because launching a browser is a real
// cost and the version/patch state is internal. The inbound-auth middleware
// above already guards every non-`/`,`/health` route, so these inherit it.

// Can puppeteer actually launch the SAME Chromium the real scrape uses? This is
// the single highest-signal light check — catches Chromium/puppeteer version
// drift, the Target.closeTarget crash class, missing Docker libs, and OOM,
// WITHOUT any bank login. Bounded by a hard timeout so a hung launch can't hang
// the request. No credentials, nothing sensitive in the response.
app.get('/health/browser', async (req, res) => {
  const t0 = Date.now();
  let browser;
  try {
    const { options } = buildLaunchOptions(null);
    const launchAndProbe = (async () => {
      browser = await puppeteer.launch(options);
      const page = await browser.newPage();
      await page.goto('about:blank');
      const chromiumVersion = await browser.version();
      return chromiumVersion;
    })();
    // 30s ceiling — a healthy launch is ~1-3s; anything near this is a red flag.
    const chromiumVersion = await Promise.race([
      launchAndProbe,
      new Promise((_, reject) => setTimeout(() => reject(new Error('launch timeout (30s)')), 30_000)),
    ]);
    res.json({ ok: true, launchMs: Date.now() - t0, chromiumVersion });
  } catch (err) {
    console.warn(`[health/browser] launch failed: ${err.message}`);
    res.status(503).json({ ok: false, launchMs: Date.now() - t0, error: err.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
});

// Report the installed israeli-bank-scrapers version + whether our patch-package
// patch is still applied. We verify by checking the patch's load-bearing strings
// in the installed file (O(1) read) rather than re-running patch-package at
// request time. patchesApplied:false means a fresh install overwrote the file
// and postinstall didn't re-apply (or a version bump silently broke the patch) —
// i.e. the retail3 Discount fix is NOT live. The watchdog turns that into a
// CRITICAL alert. No npm network call here (that comparison lives in the runner).
app.get('/health/library', (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const installedVersion = require('israeli-bank-scrapers/package.json').version;
    const discountPath = require.resolve('israeli-bank-scrapers/lib/scrapers/discount.js');
    const src = fs.readFileSync(discountPath, 'utf8');
    // The two markers the retail3 patch introduces (see
    // patches/israeli-bank-scrapers+6.7.4.patch). Both present → patch is live.
    const settleWait = src.includes('waitForUrl') && src.includes('apollo\\/retail');
    const retail3Url = src.includes('apollo/retail3/#/MY_ACCOUNT_HOMEPAGE');
    const patchesApplied = settleWait && retail3Url;
    res.json({
      ok: true,
      installedVersion,
      patchesApplied,
      patchTargets: { settleWait, retail3Url },
    });
  } catch (err) {
    console.warn(`[health/library] check failed: ${err.message}`);
    res.status(503).json({ ok: false, error: err.message });
  }
});

// Get supported companies
app.get('/api/companies', (req, res) => {
  const companies = Object.entries(COMPANY_CONFIG).map(([key, config]) => ({
    id: key,
    name: config.name,
    fields: config.fields,
  }));
  res.json({ success: true, companies });
});

// ── Async scrape queue (for webhook callbacks) ──
const MAX_CONCURRENT_SCRAPES = 3;
let activeScrapes = 0;
const scrapeQueue = [];

function enqueueScrape(job) {
  scrapeQueue.push(job);
  processQueue();
}

function processQueue() {
  while (activeScrapes < MAX_CONCURRENT_SCRAPES && scrapeQueue.length > 0) {
    activeScrapes++;
    const job = scrapeQueue.shift();
    performScrapeJob(job).finally(() => {
      activeScrapes--;
      processQueue();
    });
  }
}

async function performScrapeJob({ company, config, credentials, startDate, callbackUrl, callbackToken, bankAccountId, orgId, captureFailureScreenshot }) {
  let result;
  try {
    result = await performScrape(company, config, credentials, startDate, orgId, captureFailureScreenshot);
  } catch (error) {
    result = { success: false, error: error.message || 'Internal server error' };
  }

  // POST result to callback URL with an HMAC signature.
  try {
    // SECURITY: prefer the secret from our OWN env var over one passed in the
    // request body — the goal is that Finami stops sending the secret at all.
    // Body value is only a transition fallback.
    const signingKey = process.env.SCRAPER_CALLBACK_SECRET || callbackToken;
    if (!signingKey) {
      console.error('No callback signing key (SCRAPER_CALLBACK_SECRET unset and no callbackToken) — refusing to send unsigned callback');
      return;
    }

    // SECURITY: only ever POST results to a Convex deployment, never an
    // arbitrary URL supplied in the request (which would let a caller exfiltrate
    // scrape results / use us as an SSRF relay).
    const EXPECTED_HOST = process.env.CONVEX_SITE_URL ? new URL(process.env.CONVEX_SITE_URL).host : null;
    let cbHost;
    try {
      cbHost = new URL(callbackUrl).host;
    } catch {
      console.error(`Invalid callbackUrl, refusing to send: ${callbackUrl}`);
      return;
    }
    
    if (EXPECTED_HOST) {
      if (cbHost !== EXPECTED_HOST) {
        console.error(`callbackUrl host does not match CONVEX_SITE_URL: ${cbHost}`);
        return;
      }
    } else {
      if (!cbHost.endsWith('.convex.site') && !cbHost.endsWith('.convex.cloud')) {
        console.error(`callbackUrl host not allowlisted (must be *.convex.site/.cloud): ${cbHost}`);
        return;
      }
    }

    const payload = JSON.stringify({ ...result, bankAccountId, orgId });
    const timestamp = Date.now().toString();
    const sig = crypto
      .createHmac('sha256', signingKey)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    const headers = {
      'Content-Type': 'application/json',
      'X-Signature': sig,
      'X-Timestamp': timestamp,
    };

    console.log(`Posting callback to ${callbackUrl} ...`);
    const resp = await fetch(callbackUrl, { method: 'POST', headers, body: payload });
    console.log(`Callback response: ${resp.status}`);
  } catch (err) {
    console.error('Callback POST failed:', err.message);
  }
}

// Core scrape logic (shared by sync and async paths). `captureScreenshot`
// (per-request) OR the CAPTURE_FAILURE_SCREENSHOTS env var enables the
// diagnostic failure-page screenshot.
async function performScrape(company, config, credentials, startDate, orgId, captureScreenshot = false) {
  let browser;
  try {
    const { options: launchOptions, fp } = buildLaunchOptions(orgId);
    console.log(`[${company}] Launching browser (org: ${orgId ?? 'unknown'}, UA: ${fp.ua.slice(0, 40)}...)`);

    browser = await puppeteer.launch(launchOptions);

    const scrapeStartDate = new Date(startDate || Date.now() - 180 * 24 * 60 * 60 * 1000);
    console.log(`[${company}] Scrape start date: ${scrapeStartDate.toISOString()}`);

    // When diagnostic capture is on, tell the library to screenshot its OWN page
    // (the real bank login/error page) to this temp file at the moment login
    // fails — we read it back + upload below. This captures the correct page,
    // unlike grabbing browser.pages().last() after the library tore its page down.
    const wantCapture = captureScreenshot || CAPTURE_FAILURE_SCREENSHOTS;
    const failureShotPath = wantCapture
      ? path.join(os.tmpdir(), `fail-${company}-${Date.now()}.png`)
      : undefined;

    const scraper = createScraper({
      companyId: config.companyId,
      startDate: scrapeStartDate,
      combineInstallments: false,
      showBrowser: false,
      browser,
      // We own the browser lifecycle and close it ourselves in `finally`.
      // Without this, israeli-bank-scrapers ALSO closes it when the scrape
      // finishes → our finally then double-closes → "Protocol error
      // (Target.closeTarget): No target with given id found", which surfaced as
      // GENERAL_ERROR and masked the real scrape result. THIS is the bug — not
      // credentials, not the library version, not --single-process.
      skipCloseBrowser: true,
      ...(failureShotPath ? { storeFailureScreenShotPath: failureShotPath } : {}),
    });

    const mappedCredentials = config.mapCredentials(credentials);
    const result = await scraper.scrape(mappedCredentials);

    console.log(`[${company}] Scrape completed — success: ${result.success}`);

    if (!result.success) {
      // Log the real failure reason — errorType + errorMessage from
      // israeli-bank-scrapers. Without this the server only logged
      // "success: false", hiding WHY (e.g. GENERAL_ERROR vs INVALID_PASSWORD
      // vs CHANGE_PASSWORD), which made diagnosing stale-library/site-change
      // failures impossible. Credentials are never logged.
      console.warn(
        `[${company}] Scrape FAILED — errorType: ${result.errorType || 'SCRAPING_FAILED'} | errorMessage: ${result.errorMessage || '(none)'}`,
      );

      // Diagnostic: upload the page the LIBRARY captured at failure (the real
      // bank login/error page), so GENERAL_ERROR can be told apart from "account
      // locked" / terms popup / CAPTCHA. Off by default; enabled per-run
      // (captureScreenshot arg) or globally via CAPTURE_FAILURE_SCREENSHOTS.
      let screenshotUrl = null;
      let failurePageUrls = null;
      if (failureShotPath) {
        screenshotUrl = await uploadScreenshotFile(failureShotPath, company);
        // Capture the EXACT URL(s) the browser is on at failure. For a SPA bank
        // (Discount retail3), the library's success-URL match fails when it reads
        // the URL before the client-side hash route settles — logging the real
        // URLs tells us precisely what to match, instead of guessing URL strings.
        try {
          const pages = await browser.pages();
          failurePageUrls = (await Promise.all(pages.map(async (p) => {
            try { return p.url(); } catch { return '(closed)'; }
          }))).filter((u) => u && u !== 'about:blank');
          console.warn(`[${company}] FAILURE PAGE URLS — ${JSON.stringify(failurePageUrls)}`);
        } catch (e) {
          console.warn(`[${company}] could not read failure page URLs: ${e.message}`);
        }
      }

      return {
        success: false,
        error: result.errorType || 'SCRAPING_FAILED',
        errorMessage: result.errorMessage || null,
        ...(screenshotUrl ? { screenshotUrl } : {}),
        ...(failurePageUrls ? { failurePageUrls } : {}),
      };
    }

    const transactions = [];
    for (const account of result.accounts || []) {
      console.log(`[${company}] Account ${account.accountNumber}: balance ${account.balance}`);
      for (const txn of account.txns || []) {
        transactions.push({
          date: txn.date,
          description: txn.description,
          amount: txn.chargedAmount || txn.originalAmount,
          originalAmount: txn.originalAmount,
          originalCurrency: txn.originalCurrency,
          chargedAmount: txn.chargedAmount,
          chargedCurrency: txn.chargedCurrency,
          type: txn.type,
          status: txn.status,
          identifier: txn.identifier || null,
          memo: txn.memo || null,
          reference: txn.memo || txn.identifier || null,
          category: txn.category || null,
          installments: txn.installments || null,
        });
      }
    }

    console.log(`[${company}] Total transactions: ${transactions.length}`);

    return {
      success: true,
      company: config.name,
      transactions,
      accounts: result.accounts?.map((acc) => ({
        accountNumber: acc.accountNumber,
        balance: acc.balance,
        txnsCount: acc.txns?.length || 0,
      })) || [],
    };
  } catch (error) {
    console.error(`[${company}] Scraper error:`, error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
      console.log(`[${company}] Browser closed`);
    }
  }
}

// Generic scrape endpoint — supports both sync and async (webhook) modes
app.post('/api/scrape/:company', async (req, res) => {
  const { company } = req.params;
  // Pull control fields OUT of `credentials` so they aren't sent to the scraper
  // as bank fields. `captureFailureScreenshot` is the per-request diagnostic flag.
  const { startDate, callbackUrl, callbackToken, bankAccountId, orgId, captureFailureScreenshot, ...credentials } = req.body;

  console.log(`=== Scrape request for ${company} (${callbackUrl ? 'async' : 'sync'}) ===`, sanitizeForLog(req.body));

  const config = COMPANY_CONFIG[company];
  if (!config) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_COMPANY',
      message: `Company '${company}' is not supported`,
      supportedCompanies: Object.keys(COMPANY_CONFIG),
    });
  }

  const missingFields = config.fields.filter((field) => !credentials[field]);
  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      error: 'MISSING_CREDENTIALS',
      message: `Missing required fields: ${missingFields.join(', ')}`,
      requiredFields: config.fields,
    });
  }

  // ── Async mode: return 202 immediately, POST results to callbackUrl ──
  if (callbackUrl) {
    const jobId = `${company}-${Date.now()}`;
    console.log(`[${jobId}] Enqueuing async scrape (queue: ${scrapeQueue.length}, active: ${activeScrapes})`);
    enqueueScrape({ company, config, credentials, startDate, callbackUrl, callbackToken, bankAccountId, orgId, captureFailureScreenshot });
    return res.status(202).json({ accepted: true, jobId });
  }

  // ── Sync mode: existing behavior ──
  try {
    const result = await performScrape(company, config, credentials, startDate, orgId, captureFailureScreenshot);
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
});

// Legacy endpoint for discount (backward compatibility)
app.post('/api/scrape-discount', async (req, res) => {
  const { id, password, userCode, startDate } = req.body;

  // Forward to generic endpoint with correct field mapping
  req.params = { company: 'discount' };
  req.body = { id, password, num: userCode, startDate };

  // Re-route to generic handler
  return app._router.handle({ ...req, url: '/api/scrape/discount', method: 'POST' }, res, () => {});
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Chromium path:', process.env.PUPPETEER_EXECUTABLE_PATH || '(puppeteer bundled)');
  console.log('Supported companies:', Object.keys(COMPANY_CONFIG).join(', '));
});

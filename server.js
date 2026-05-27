const express = require('express');
const crypto = require('crypto');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createScraper, CompanyTypes } = require('israeli-bank-scrapers');

puppeteer.use(StealthPlugin());

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

async function performScrapeJob({ company, config, credentials, startDate, callbackUrl, callbackToken, bankAccountId, orgId }) {
  let result;
  try {
    result = await performScrape(company, config, credentials, startDate, orgId);
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

// Core scrape logic (shared by sync and async paths)
async function performScrape(company, config, credentials, startDate, orgId) {
  let browser;
  try {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
    const fp = orgId ? getFingerprintForOrg(orgId) : { ua: BROWSER_PROFILES[0].ua, timezone: 'Asia/Jerusalem', language: 'he-IL' };
    console.log(`[${company}] Launching browser (org: ${orgId ?? 'unknown'}, UA: ${fp.ua.slice(0, 40)}...)`);

    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // NOTE: --single-process and --no-zygote were REMOVED (2026-05-27).
        // They were the cause of "Protocol error (Target.closeTarget): No
        // target with given id found" — Chromium's single-process mode crashes
        // the renderer target mid-navigation on heavy bank pages. Memory was
        // never the constraint (peak ~0.4GB), so these flags only hurt.
        '--disable-blink-features=AutomationControlled',
        `--user-agent=${fp.ua}`,
        `--lang=${fp.language}`,
      ],
    });

    const scrapeStartDate = new Date(startDate || Date.now() - 180 * 24 * 60 * 60 * 1000);
    console.log(`[${company}] Scrape start date: ${scrapeStartDate.toISOString()}`);

    const scraper = createScraper({
      companyId: config.companyId,
      startDate: scrapeStartDate,
      combineInstallments: false,
      showBrowser: false,
      browser,
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
      return {
        success: false,
        error: result.errorType || 'SCRAPING_FAILED',
        errorMessage: result.errorMessage || null,
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
  const { startDate, callbackUrl, callbackToken, bankAccountId, orgId, ...credentials } = req.body;

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
    enqueueScrape({ company, config, credentials, startDate, callbackUrl, callbackToken, bankAccountId, orgId });
    return res.status(202).json({ accepted: true, jobId });
  }

  // ── Sync mode: existing behavior ──
  try {
    const result = await performScrape(company, config, credentials, startDate, orgId);
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
  console.log('Chromium path:', process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium');
  console.log('Supported companies:', Object.keys(COMPANY_CONFIG).join(', '));
});

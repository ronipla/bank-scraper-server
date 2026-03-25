const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createScraper, CompanyTypes } = require('israeli-bank-scrapers');

puppeteer.use(StealthPlugin());

// Common Chrome user agents for rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

async function performScrapeJob({ company, config, credentials, startDate, callbackUrl, callbackToken }) {
  let result;
  try {
    result = await performScrape(company, config, credentials, startDate);
  } catch (error) {
    result = { success: false, error: error.message || 'Internal server error' };
  }

  // POST result to callback URL
  try {
    console.log(`Posting callback to ${callbackUrl} ...`);
    const resp = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(callbackToken ? { Authorization: `Bearer ${callbackToken}` } : {}),
      },
      body: JSON.stringify(result),
    });
    console.log(`Callback response: ${resp.status}`);
  } catch (err) {
    console.error('Callback POST failed:', err.message);
  }
}

// Core scrape logic (shared by sync and async paths)
async function performScrape(company, config, credentials, startDate) {
  let browser;
  try {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
    const userAgent = getRandomUserAgent();
    console.log(`[${company}] Launching browser (UA: ${userAgent.slice(0, 40)}...)`);

    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-blink-features=AutomationControlled',
        `--user-agent=${userAgent}`,
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
  const { startDate, callbackUrl, callbackToken, ...credentials } = req.body;

  console.log(`=== Scrape request for ${company} (${callbackUrl ? 'async' : 'sync'}) ===`);

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
    enqueueScrape({ company, config, credentials, startDate, callbackUrl, callbackToken });
    return res.status(202).json({ accepted: true, jobId });
  }

  // ── Sync mode: existing behavior ──
  try {
    const result = await performScrape(company, config, credentials, startDate);
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

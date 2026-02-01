const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { createScraper, CompanyTypes } = require('israeli-bank-scrapers');

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

// Generic scrape endpoint
app.post('/api/scrape/:company', async (req, res) => {
  const { company } = req.params;
  const { startDate, ...credentials } = req.body;

  console.log(`=== Scrape request received for ${company} ===`);

  const config = COMPANY_CONFIG[company];
  if (!config) {
    console.log('Invalid company:', company);
    return res.status(400).json({
      success: false,
      error: 'INVALID_COMPANY',
      message: `Company '${company}' is not supported`,
      supportedCompanies: Object.keys(COMPANY_CONFIG),
    });
  }

  // Validate required fields
  const missingFields = config.fields.filter((field) => !credentials[field]);
  if (missingFields.length > 0) {
    console.log('Missing fields:', missingFields);
    return res.status(400).json({
      success: false,
      error: 'MISSING_CREDENTIALS',
      message: `Missing required fields: ${missingFields.join(', ')}`,
      requiredFields: config.fields,
    });
  }

  console.log('Company:', config.name);
  console.log('Fields received:', config.fields.map((f) => `${f}: ${credentials[f]?.length || 0} chars`).join(', '));

  let browser;
  try {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
    console.log('Using Chromium at:', executablePath);

    const launchOptions = {
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
      ],
    };

    console.log('Launching browser...');
    browser = await puppeteer.launch(launchOptions);
    console.log('Browser launched successfully');

    const scrapeStartDate = new Date(startDate || Date.now() - 180 * 24 * 60 * 60 * 1000);
    console.log('Scrape start date:', scrapeStartDate.toISOString());

    const scraper = createScraper({
      companyId: config.companyId,
      startDate: scrapeStartDate,
      combineInstallments: false,
      showBrowser: false,
      browser,
    });

    console.log('Scraper created, starting scrape...');
    const mappedCredentials = config.mapCredentials(credentials);
    const result = await scraper.scrape(mappedCredentials);

    console.log('Scrape completed');
    console.log('Success:', result.success);
    console.log('Error type:', result.errorType || 'none');
    console.log('Error message:', result.errorMessage || 'none');

    if (!result.success) {
      console.log('Scrape failed with error:', result.errorType);
      return res.status(400).json({
        success: false,
        error: result.errorType || 'SCRAPING_FAILED',
        errorMessage: result.errorMessage || null,
      });
    }

    const transactions = [];
    for (const account of result.accounts || []) {
      console.log('Processing account:', account.accountNumber);
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
          category: txn.category || null,
          installments: txn.installments || null,
        });
      }
    }

    console.log('Total transactions:', transactions.length);

    return res.json({
      success: true,
      company: config.name,
      transactions,
      accounts: result.accounts?.map((acc) => ({
        accountNumber: acc.accountNumber,
        balance: acc.balance,
        txnsCount: acc.txns?.length || 0,
      })) || [],
    });
  } catch (error) {
    console.error('=== Scraper error ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  } finally {
    if (browser) {
      console.log('Closing browser...');
      await browser.close();
      console.log('Browser closed');
    }
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

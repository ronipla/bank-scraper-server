const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { createScraper, CompanyTypes } = require('israeli-bank-scrapers');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Bank scraper server is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Scrape Discount Bank
app.post('/api/scrape-discount', async (req, res) => {
  const { id, password, userCode, startDate } = req.body;

  if (!id || !password || !userCode) {
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }

  let browser;
  try {
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
    };

    // Use system Chromium if available (Docker environment)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    browser = await puppeteer.launch(launchOptions);

    const scraper = createScraper({
      companyId: CompanyTypes.discount,
      startDate: new Date(startDate || Date.now() - 180 * 24 * 60 * 60 * 1000),
      combineInstallments: false,
      showBrowser: false,
      browser,
    });

    const result = await scraper.scrape({
      id,
      password,
      userCode,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.errorType || 'Scraping failed',
      });
    }

    const transactions = [];
    for (const account of result.accounts || []) {
      for (const txn of account.txns || []) {
        transactions.push({
          date: txn.date,
          description: txn.description,
          amount: txn.chargedAmount || txn.originalAmount,
          reference: txn.identifier || null,
          identifier: txn.identifier || null,
        });
      }
    }

    return res.json({
      success: true,
      transactions,
      accountNumber: result.accounts?.[0]?.accountNumber || null,
    });
  } catch (error) {
    console.error('Scraper error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

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
  console.log('=== Scrape request received ===');
  const { id, password, userCode, startDate } = req.body;

  if (!id || !password || !userCode) {
    console.log('Missing credentials');
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }

  console.log('Credentials received, starting scraper...');
  console.log('User ID length:', id?.length);
  console.log('Password length:', password?.length);
  console.log('UserCode length:', userCode?.length);

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
      companyId: CompanyTypes.discount,
      startDate: scrapeStartDate,
      combineInstallments: false,
      showBrowser: false,
      browser,
    });

    console.log('Scraper created, starting scrape...');
    const result = await scraper.scrape({
      id,
      password,
      userCode,
    });

    console.log('Scrape completed');
    console.log('Success:', result.success);
    console.log('Error type:', result.errorType || 'none');
    console.log('Error message:', result.errorMessage || 'none');

    if (!result.success) {
      console.log('Scrape failed with error:', result.errorType);
      return res.status(400).json({
        success: false,
        error: result.errorType || 'Scraping failed',
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
          reference: txn.identifier || null,
          identifier: txn.identifier || null,
        });
      }
    }

    console.log('Total transactions:', transactions.length);

    return res.json({
      success: true,
      transactions,
      accountNumber: result.accounts?.[0]?.accountNumber || null,
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Chromium path:', process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium');
});

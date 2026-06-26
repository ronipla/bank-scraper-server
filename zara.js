// Zara per-country price reader (SubIndex "universal product price finder" POC).
//
// Reuses this server's existing Puppeteer + stealth stack to read ONE product's
// price across every Zara store. Plain `fetch` is dead for Zara (Akamai Bot
// Manager serves a JS proof-of-work interstitial); a real browser passes it, and
// the store PATH (/de/de/, /jp/ja/) controls currency+locale — no geo proxy needed.
//
// Fully isolated from the bank scrapers: its own browser per request, its own
// try/catch per page, browser always closed in finally — a Zara failure can
// never touch a bank sync.

// Zara product URL: https://www.zara.com/{store}/{lang}/{slug}-p{ID}.html
// The slug is cosmetic; Zara resolves by -p{ID}. A dead id 301s to /search.
const DEFAULT_MARKETS = [
  ["us", "en"], ["ca", "en"], ["uk", "en"], ["ie", "en"], ["es", "es"], ["pt", "pt"],
  ["fr", "fr"], ["de", "de"], ["it", "it"], ["nl", "en"], ["ch", "en"], ["at", "de"],
  ["se", "en"], ["pl", "pl"], ["gr", "en"], ["tr", "tr"], ["il", "en"], ["ae", "en"],
  ["jp", "ja"], ["kr", "ko"], ["cn", "zh"], ["in", "en"], ["mx", "es"], ["au", "en"],
];

// Currencies with no minor unit — their displayed thousands separators must NOT
// be read as decimals (¥25,990 = 25990, never 25.990).
const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "ISK", "HUF", "VND", "TWD"]);

function parseProductId(input) {
  if (!input) return null;
  const m = String(input).match(/-p(\d{6,})\.html/) || String(input).match(/^(\d{6,})$/);
  return m ? m[1] : null;
}

// Parse a localised money string ("139,00 EUR", "25,990", "$ 1,299.00") into a
// Number, using the currency to disambiguate the separator convention.
function parseMoney(text, currency) {
  if (!text) return null;
  const s = (text.match(/\d[\d.,]*\d|\d/) || [])[0];
  if (!s) return null;
  if (ZERO_DECIMAL.has(currency)) return Number(s.replace(/[.,]/g, ""));
  const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  if (lastSep >= 0 && s.length - lastSep - 1 === 2) {
    const intPart = s.slice(0, lastSep).replace(/[.,]/g, "");
    return Number(`${intPart}.${s.slice(lastSep + 1)}`);
  }
  return Number(s.replace(/[.,]/g, ""));
}

// Runs in the page: pull the displayed original + current price strings and the
// ISO currency from the embedded app state. We read the DISPLAY text (ground
// truth), never the state "price" number (it is scaled inconsistently per
// currency, e.g. JPY is stored /100).
function extractInPage() {
  const html = document.documentElement.innerHTML;
  const currency = (html.match(/"currency(?:Code)?"\s*:\s*"([A-Z]{3})"/) || [])[1] || null;
  // Read the per-amount price element (`money-amount__main`) — its textContent is
  // ONE price ("139,00 EUR"), so we never concatenate the discount badge into the
  // number (FR renders "-35 %" with a space, which a broad parent selector glued
  // onto the price → "3590,35"). Fall back to leaf price nodes if the class drifts.
  let amounts = [...document.querySelectorAll('[class*="money-amount__main"]')]
    .map((e) => e.textContent.trim())
    .filter((t) => /\d/.test(t) && !/%/.test(t));
  if (amounts.length === 0) {
    amounts = [...document.querySelectorAll('[class*="price"] *, [class*="price"]')]
      .filter((e) => e.children.length === 0 && /\d/.test(e.textContent) && !/%/.test(e.textContent))
      .map((e) => e.textContent.trim());
  }
  return { currency, amounts: [...new Set(amounts)], finalUrl: location.href, title: document.title };
}

async function readMarket(browser, productId, store, lang, log) {
  const url = `https://www.zara.com/${store}/${lang}/x-p${productId}.html`;
  let page;
  try {
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": `${lang},en;q=0.8` });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait until either a real price renders, or we land on /search (= the id is
    // not sold in this store). Also clears the Akamai interstitial, which needs a
    // few seconds of JS to resolve before the product DOM appears.
    await page
      .waitForFunction(
        () => /\/search/.test(location.href) || document.querySelector('[class*="price"]'),
        { timeout: 20000 },
      )
      .catch(() => {});
    const data = await page.evaluate(extractInPage);
    if (/\/search/.test(data.finalUrl)) {
      return { store, lang, available: false, reason: "not-sold" };
    }
    const nums = data.amounts.map((t) => parseMoney(t, data.currency)).filter((n) => Number.isFinite(n) && n > 0);
    if (!data.currency || nums.length === 0) {
      return { store, lang, available: false, reason: "no-price" };
    }
    const original = Math.max(...nums);
    const current = Math.min(...nums);
    return {
      store,
      lang,
      available: true,
      currency: data.currency,
      originalAmount: original,
      currentAmount: current,
      onSale: current < original,
      url: data.finalUrl,
    };
  } catch (e) {
    log(`[zara] ${store}/${lang} failed: ${e.message}`);
    return { store, lang, available: false, reason: "error", error: e.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Express handler factory. Pass the server's shared `puppeteer` (already has the
// stealth plugin) and `buildLaunchOptions` so launch args stay single-sourced.
function createZaraHandler({ puppeteer, buildLaunchOptions }) {
  return async function handleZaraPrice(req, res) {
    const productId = parseProductId(req.body.productId) || parseProductId(req.body.url);
    if (!productId) {
      return res.status(400).json({ success: false, error: "MISSING_PRODUCT_ID", message: "Provide productId or a Zara product url" });
    }
    const markets = Array.isArray(req.body.countries) && req.body.countries.length
      ? req.body.countries.map((c) => (Array.isArray(c) ? c : String(c).split("/"))).filter((p) => p.length === 2)
      : DEFAULT_MARKETS;

    const log = (m) => console.log(m);
    log(`=== Zara price request: product ${productId} across ${markets.length} stores ===`);
    const started = Date.now();
    let browser;
    try {
      const { options } = buildLaunchOptions();
      browser = await puppeteer.launch(options);
      // Limited concurrency: 5 pages share ONE browser, so a batch of ~5 markets
      // returns in ~3s instead of ~9s. The caller (Convex) sends small batches
      // sequentially, so only one of these browsers is ever live at a time —
      // keeping memory bounded and never crowding the bank scrapers.
      const CONCURRENCY = 5;
      const results = new Array(markets.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < markets.length) {
          const idx = cursor++;
          const [store, lang] = markets[idx];
          results[idx] = await readMarket(browser, productId, store, lang, log);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, markets.length) }, worker));
      const available = results.filter((r) => r.available);
      return res.json({
        success: true,
        productId,
        markets: markets.length,
        availableCount: available.length,
        durationMs: Date.now() - started,
        results,
      });
    } catch (error) {
      log(`[zara] fatal: ${error.message}`);
      return res.status(500).json({ success: false, error: error.message || "ZARA_SCRAPE_FAILED" });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  };
}

module.exports = { createZaraHandler, parseProductId, parseMoney, DEFAULT_MARKETS };

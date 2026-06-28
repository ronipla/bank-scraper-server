// Multi-retailer per-country price reader (SubIndex product finder).
//
// Reuses this server's Puppeteer + stealth to read ONE product's price across a
// retailer's country stores. Plain fetch is dead for these chains (Akamai); a
// real browser passes it and the store PATH sets currency — no geo proxy.
//
// Each retailer is an ADAPTER: how to build a product URL from {store,lang,id}
// and how to read its main price element. Inditex brands (Zara/Bershka/Pull&Bear/
// Stradivarius/Massimo Dutti) share this shape, so adding one is a few lines.
//
// Fully isolated from the bank scrapers: own browser per request, per-page
// try/catch, browser always closed in finally.

const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "ISK", "HUF", "VND", "TWD"]);
const VALID_ISO = new Set([
  "USD", "EUR", "GBP", "ILS", "JPY", "KRW", "TRY", "INR", "AED", "SAR", "MXN", "BRL", "CAD", "AUD", "NZD",
  "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "CNY", "HKD", "TWD", "SGD", "MYR", "THB", "IDR",
  "PHP", "VND", "ZAR", "EGP", "NGN", "UAH", "KZT", "BDT", "PKR", "QAR", "KWD",
]);
// Symbols longest-first so "US$"/"HK$" win over "$". "kr" last-ish (ambiguous).
const SYMBOL_ISO = [
  ["US$", "USD"], ["CA$", "CAD"], ["A$", "AUD"], ["NZ$", "NZD"], ["HK$", "HKD"], ["NT$", "TWD"], ["S$", "SGD"],
  ["R$", "BRL"], ["MX$", "MXN"], ["zł", "PLN"], ["Kč", "CZK"], ["Rp", "IDR"], ["RM", "MYR"],
  ["₺", "TRY"], ["₪", "ILS"], ["₩", "KRW"], ["₹", "INR"], ["₱", "PHP"], ["฿", "THB"], ["₫", "VND"],
  ["￥", "JPY"], ["¥", "JPY"], ["€", "EUR"], ["£", "GBP"], ["CHF", "CHF"], ["AED", "AED"], ["SAR", "SAR"], ["kr", "SEK"], ["$", "USD"],
];

// Currency from a displayed price token ("139,00 EUR", "35,99 €", "$ 219.00").
function currencyFromText(t) {
  const code = (t.toUpperCase().match(/\b([A-Z]{3})\b/) || [])[1];
  if (code && VALID_ISO.has(code)) return code;
  for (const [sym, iso] of SYMBOL_ISO) if (t.includes(sym)) return iso;
  return null;
}

// Parse a localised amount using the currency to disambiguate separators.
function parseMoney(text, currency) {
  if (!text) return null;
  const s = (text.match(/\d[\d.,]*\d|\d/) || [])[0];
  if (!s) return null;
  if (ZERO_DECIMAL.has(currency)) return Number(s.replace(/[.,]/g, ""));
  const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  if (lastSep >= 0 && s.length - lastSep - 1 === 2) {
    return Number(`${s.slice(0, lastSep).replace(/[.,]/g, "")}.${s.slice(lastSep + 1)}`);
  }
  return Number(s.replace(/[.,]/g, ""));
}

// ── Retailer adapters ──
// `extract` runs IN the page; it returns the MAIN product's price strings only
// (1 = no sale, 2 = sale → we take max as original, min as current).
const RETAILERS = {
  zara: {
    host: "www.zara.com",
    idFromUrl: (u) => (u.match(/-p(\d{6,})\.html/) || [])[1] || null,
    buildUrl: (store, lang, id) => `https://www.zara.com/${store}/${lang || "en"}/x-p${id}.html`,
    ready: '[class*="money-amount__main"], [class*="price"]',
    extract: () => {
      // Zara exposes a reliable ISO currency in its app state — use it (the ¥
      // symbol is shared by JPY and CNY, so a symbol guess is ambiguous).
      const currency = (document.documentElement.innerHTML.match(/"currency(?:Code)?"\s*:\s*"([A-Z]{3})"/) || [])[1] || null;
      const a = [...document.querySelectorAll('[class*="money-amount__main"]')]
        .map((e) => e.textContent.trim())
        .filter((t) => /\d/.test(t) && !/%/.test(t));
      return { amounts: [...new Set(a)], currency, finalUrl: location.href };
    },
  },
  bershka: {
    host: "www.bershka.com",
    idFromUrl: (u) => (u.match(/c\d+p(\d{6,})\.html/) || u.match(/c0p(\d{6,})/) || u.match(/p(\d{6,})\.html/) || [])[1] || null,
    buildUrl: (store, _lang, id) => `https://www.bershka.com/${store}/x-c0p${id}.html`,
    ready: '[class*="product-detail-info__price"]',
    extract: () => {
      const box = document.querySelector('[class*="product-detail-info__price"]');
      let a = [];
      if (box) {
        a = [...box.querySelectorAll("*")]
          .filter((e) => e.children.length === 0 && /\d/.test(e.textContent) && !/%/.test(e.textContent))
          .map((e) => e.textContent.trim());
        if (!a.length && /\d/.test(box.textContent)) a = [box.textContent.trim()];
      }
      return { amounts: [...new Set(a)], finalUrl: location.href };
    },
  },
};

const SEARCH_RE = /\/search|\/buscar|\/category|\/categoria/i;

async function readMarket(browser, retailerKey, productId, store, lang, log) {
  const R = RETAILERS[retailerKey];
  const url = R.buildUrl(store, lang, productId);
  let page;
  try {
    page = await browser.newPage();
    if (lang) await page.setExtraHTTPHeaders({ "Accept-Language": `${lang},en;q=0.8` });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page
      .waitForFunction(
        (sel) => /\/search|\/buscar|\/category|\/categoria/i.test(location.href) || document.querySelector(sel),
        { timeout: 20000 },
        R.ready,
      )
      .catch(() => {});
    const data = await page.evaluate(R.extract);
    if (SEARCH_RE.test(data.finalUrl)) return { store, available: false, reason: "not-sold" };
    // Prefer the adapter's state currency (reliable ISO); else derive from symbol.
    const stateCur = data.currency && VALID_ISO.has(data.currency) ? data.currency : null;
    const parsed = data.amounts.map((t) => ({ t, cur: stateCur || currencyFromText(t) })).filter((x) => x.cur);
    if (!parsed.length) return { store, available: false, reason: "no-price" };
    const cur = parsed[0].cur;
    const nums = parsed.map((x) => parseMoney(x.t, cur)).filter((n) => Number.isFinite(n) && n > 0);
    if (!nums.length) return { store, available: false, reason: "no-price" };
    const original = Math.max(...nums);
    const current = Math.min(...nums);
    return { store, available: true, currency: cur, originalAmount: original, currentAmount: current, onSale: current < original, url: data.finalUrl };
  } catch (e) {
    log(`[retail] ${retailerKey} ${store} failed: ${e.message}`);
    return { store, available: false, reason: "error", error: e.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Express handler factory. Body: { retailer?, productId | url, stores: [{store,lang} | "store/lang" | "store"] }.
function createRetailHandler({ puppeteer, buildLaunchOptions }) {
  return async function handleRetailPrice(req, res) {
    const retailer = String(req.body.retailer || "zara").toLowerCase();
    const R = RETAILERS[retailer];
    if (!R) return res.status(400).json({ success: false, error: "UNKNOWN_RETAILER", supported: Object.keys(RETAILERS) });
    const productId = (req.body.productId ? String(req.body.productId).match(/\d{6,}/)?.[0] : null) || (req.body.url ? R.idFromUrl(req.body.url) : null);
    if (!productId) return res.status(400).json({ success: false, error: "MISSING_PRODUCT_ID" });

    const raw = req.body.stores || req.body.countries || [];
    const stores = raw
      .map((c) => (Array.isArray(c) ? { store: c[0], lang: c[1] || "" } : typeof c === "object" ? { store: c.store, lang: c.lang || "" } : { store: String(c).split("/")[0], lang: String(c).split("/")[1] || "" }))
      .filter((x) => x.store);
    if (!stores.length) return res.status(400).json({ success: false, error: "NO_STORES" });

    const log = (m) => console.log(m);
    log(`=== ${retailer} price: product ${productId} × ${stores.length} stores ===`);
    const started = Date.now();
    let browser;
    try {
      const { options } = buildLaunchOptions();
      browser = await puppeteer.launch(options);
      const CONCURRENCY = 5;
      const results = new Array(stores.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < stores.length) {
          const i = cursor++;
          results[i] = await readMarket(browser, retailer, productId, stores[i].store, stores[i].lang, log);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stores.length) }, worker));
      const available = results.filter((r) => r.available);
      return res.json({ success: true, retailer, productId, markets: stores.length, availableCount: available.length, durationMs: Date.now() - started, results });
    } catch (error) {
      log(`[retail] fatal: ${error.message}`);
      return res.status(500).json({ success: false, error: error.message || "RETAIL_SCRAPE_FAILED" });
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  };
}

module.exports = { createRetailHandler, RETAILERS, parseMoney, currencyFromText };

// Shared alerting for the watchdog + canary. Fires to BOTH Telegram (primary,
// reliable) and a Hermes webhook (secondary, may be down) — each best-effort and
// independent, so one failing never blocks the other. Missing secrets => that
// channel is skipped silently (graceful: an unconfigured notify still lets the
// caller run and report via the GitHub step summary). NEVER throws, NEVER logs
// the token or any credential.
//
// No dependencies — built-in fetch (Node 18+) + AbortController only.

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HERMES_WEBHOOK_URL = process.env.HERMES_WEBHOOK_URL;

// Abort a hung channel after this long so a stuck WSL Hermes bridge can't make
// the whole job hang.
const CHANNEL_TIMEOUT_MS = 5000;

function buildRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  }
  return null;
}

function israelTime() {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jerusalem',
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

// Build the plain-text alert body from a structured input. `lines` is an array
// of "Label: value" rows; null/undefined rows are dropped.
function formatMessage({ title, severity, lines = [], screenshotUrl }) {
  const runUrl = buildRunUrl();
  const parts = [
    `🚨 Finami Scraper Watchdog — ${severity}`,
    '',
    title,
    '',
    ...lines.filter(Boolean),
  ];
  if (screenshotUrl) parts.push(`Screenshot: ${screenshotUrl}`);
  if (runUrl) parts.push(`Run: ${runUrl}`);
  parts.push(`Time: ${israelTime()} (Israel)`);
  return parts.join('\n');
}

async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHANNEL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[notify] telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing) — skipping');
    return { channel: 'telegram', skipped: true };
  }
  try {
    // Token only ever lives inside this URL string — never logged.
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: false,
      }),
    });
    if (!resp.ok) {
      console.warn(`[notify] telegram HTTP ${resp.status}`);
      return { channel: 'telegram', ok: false, status: resp.status };
    }
    console.log('[notify] telegram sent');
    return { channel: 'telegram', ok: true };
  } catch (err) {
    console.warn(`[notify] telegram error: ${err.message}`);
    return { channel: 'telegram', ok: false, error: err.message };
  }
}

async function sendHermes(text) {
  if (!HERMES_WEBHOOK_URL) {
    console.log('[notify] hermes not configured (HERMES_WEBHOOK_URL missing) — skipping');
    return { channel: 'hermes', skipped: true };
  }
  try {
    const resp = await fetchWithTimeout(HERMES_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      console.warn(`[notify] hermes HTTP ${resp.status}`);
      return { channel: 'hermes', ok: false, status: resp.status };
    }
    console.log('[notify] hermes sent');
    return { channel: 'hermes', ok: true };
  } catch (err) {
    console.warn(`[notify] hermes error: ${err.message}`);
    return { channel: 'hermes', ok: false, error: err.message };
  }
}

/**
 * Send an alert to all configured channels. Best-effort, never throws.
 * @param {{title:string, severity:'CRITICAL'|'WARN'|'INFO', lines?:string[], screenshotUrl?:string}} input
 * @returns {Promise<Array>} per-channel results (for the step summary)
 */
export async function notify(input) {
  const text = formatMessage(input);
  const results = await Promise.allSettled([sendTelegram(text), sendHermes(text)]);
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason) }));
}

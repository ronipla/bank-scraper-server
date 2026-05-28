// Layer-2 canary — a SINGLE real bank login per run, once per day, against a
// DEDICATED TEST account (never a customer's). Verifies the full deployed stack
// (browser + stealth + ibs library + retail3 patch) can still log into a real
// bank — catches a site change (the exact Discount-retail3 class of break) that
// the light checks can't see.
//
// ── LOCKOUT SAFETY (hard requirement) ──────────────────────────────────────
//  • Exactly ONE POST. No loop, no retry, no catch-and-retry anywhere below.
//  • Sync mode (no callbackUrl) → result returns inline, no Convex, no DB.
//  • The workflow runs this once/day on cron only (no `push`) with a
//    concurrency group, so it cannot double-fire.
//  • Dedicated throwaway account (CANARY_CREDENTIALS secret) — a customer
//    account is NEVER touched (we bypass Convex entirely).
//  • Single company (CANARY_BANK_TYPE). It does not iterate over banks.
// A failed login → ONE alert; the script then exits. It never tries again.
//
// No dependencies — built-in fetch only.

import { appendFileSync } from 'node:fs';
import { notify } from './notify.mjs';

const SCRAPER_URL = process.env.SCRAPER_URL;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const CANARY_BANK_TYPE = process.env.CANARY_BANK_TYPE; // e.g. "discount"
const CANARY_CREDENTIALS = process.env.CANARY_CREDENTIALS; // JSON of the bank's fields
// A real login can take a while; the scrape itself is also bounded server-side.
const REQUEST_TIMEOUT_MS = 120_000;

function summary(line) {
  console.log(line);
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) {
    try { appendFileSync(f, line + '\n'); } catch { /* ignore */ }
  }
}

async function main() {
  // Dormancy gate: without a test account this is a no-op (the workflow guard
  // should already prevent this, but double-check here).
  if (!SCRAPER_URL || !SCRAPER_API_KEY || !CANARY_BANK_TYPE || !CANARY_CREDENTIALS) {
    summary('⏭️ canary skipped — SCRAPER_URL / SCRAPER_API_KEY / CANARY_BANK_TYPE / CANARY_CREDENTIALS not all set.');
    return; // exit 0
  }

  let creds;
  try {
    creds = JSON.parse(CANARY_CREDENTIALS);
  } catch {
    // Do NOT log the raw value — it's a credential.
    summary('❌ canary: CANARY_CREDENTIALS is not valid JSON.');
    await notify({
      title: 'Canary misconfigured — CANARY_CREDENTIALS is not valid JSON',
      severity: 'CRITICAL',
      lines: ['• Fix the CANARY_CREDENTIALS secret (must be JSON of the bank fields).'],
    });
    return; // exit 0, no scrape attempted
  }

  summary(`🐤 canary: one login attempt to ${CANARY_BANK_TYPE} (test account)…`);

  // THE single attempt. Sync mode (no callbackUrl). No retry wrapper.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let result;
  let httpStatus;
  try {
    const resp = await fetch(`${SCRAPER_URL}/api/scrape/${encodeURIComponent(CANARY_BANK_TYPE)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SCRAPER_API_KEY}` },
      body: JSON.stringify({
        ...creds,
        // Short window — minimize work + time on the bank.
        startDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        // Capture the bank's error page on failure → URL comes back in the body.
        captureFailureScreenshot: true,
      }),
      signal: ctrl.signal,
    });
    httpStatus = resp.status;
    try { result = await resp.json(); } catch { result = null; }
  } catch (err) {
    // Network error / timeout — report and STOP. No retry.
    summary(`❌ canary: request failed (${err.message}) — NOT retrying.`);
    await notify({
      title: `Canary login to ${CANARY_BANK_TYPE} could not reach the scraper`,
      severity: 'CRITICAL',
      lines: [`• ${err.message}`, '• (single attempt — no retry, per lockout policy)'],
    });
    return; // exit 0
  } finally {
    clearTimeout(timer);
  }

  if (result?.success) {
    const accounts = Array.isArray(result.accounts) ? result.accounts.length : '?';
    const txns = Array.isArray(result.transactions) ? result.transactions.length : '?';
    summary(`✅ canary: ${CANARY_BANK_TYPE} login OK — ${accounts} account(s), ${txns} txn(s). No alert.`);
    return; // healthy → no alert
  }

  // Failed login — ONE alert, then stop.
  const errType = result?.error ?? `HTTP ${httpStatus}`;
  const errMsg = result?.errorMessage ?? '(none)';
  const screenshotUrl = result?.screenshotUrl ?? null;
  summary(`❌ canary: ${CANARY_BANK_TYPE} login FAILED — ${errType} / ${errMsg}`);
  await notify({
    title: `Canary login to ${CANARY_BANK_TYPE} FAILED — the bank scraper may be broken`,
    severity: 'CRITICAL',
    lines: [
      `• Bank: ${CANARY_BANK_TYPE}`,
      `• Error: ${errType}`,
      `• Message: ${errMsg}`,
      '• (single attempt — no retry, per lockout policy)',
    ],
    screenshotUrl,
  });
}

main().catch((err) => {
  // Script crash (not a login failure) — report, exit 0, no retry.
  console.error(`[canary] fatal: ${err.stack || err.message}`);
  summary(`💥 canary script crashed: ${err.message}`);
  notify({
    title: 'Canary SCRIPT crashed (not a login result)',
    severity: 'CRITICAL',
    lines: [`• ${err.message}`],
  }).finally(() => process.exit(0));
});

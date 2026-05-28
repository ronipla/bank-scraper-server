// Light watchdog — runs frequently (GitHub Actions cron), zero bank logins.
// Hits the DEPLOYED scraper's health endpoints over HTTPS (so it tests the live
// Railway instance, not local code) and compares the installed
// israeli-bank-scrapers version to the latest on npm. On a CRITICAL finding it
// fires an alert via notify(); it ALWAYS writes a digest to the GitHub step
// summary. It NEVER hard-fails the job (exit 0 even on detected breakage) —
// the signal is the alert + summary, not a red build. Reserve a non-zero exit
// only for the script itself crashing.
//
// No dependencies — built-in fetch + node:child_process (npm view) only.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { notify } from './notify.mjs';

const SCRAPER_URL = process.env.SCRAPER_URL;
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const REQUEST_TIMEOUT_MS = 40_000; // browser launch can take ~30s

function summary(line) {
  console.log(line);
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) {
    try { appendFileSync(f, line + '\n'); } catch { /* ignore */ }
  }
}

async function getJson(path, { auth = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${SCRAPER_URL}${path}`, {
      headers: auth ? { Authorization: `Bearer ${SCRAPER_API_KEY}` } : {},
      signal: ctrl.signal,
    });
    let body = null;
    try { body = await resp.json(); } catch { /* non-JSON */ }
    return { status: resp.status, ok: resp.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

function latestNpmVersion(pkg) {
  try {
    // execFileSync (not exec) — no shell, pkg is a constant, no injection surface.
    const out = execFileSync('npm', ['view', pkg, 'version'], { encoding: 'utf8', timeout: 20_000 });
    return out.trim() || null;
  } catch (err) {
    console.warn(`[watchdog] npm view failed: ${err.message}`);
    return null;
  }
}

async function main() {
  if (!SCRAPER_URL || !SCRAPER_API_KEY) {
    summary('⏭️ watchdog skipped — SCRAPER_URL / SCRAPER_API_KEY not set.');
    return; // exit 0 — nothing to check yet
  }

  const critical = [];
  const warn = [];
  const lines = [];

  // 1. Server up?
  try {
    const health = await getJson('/health');
    if (health.ok) {
      summary('✅ /health: up');
    } else {
      critical.push(`scraper /health returned HTTP ${health.status}`);
      summary(`❌ /health: HTTP ${health.status}`);
    }
  } catch (err) {
    critical.push(`scraper unreachable: ${err.message}`);
    summary(`❌ /health: unreachable (${err.message})`);
  }

  // 2. Browser launch?
  try {
    const b = await getJson('/health/browser', { auth: true });
    if (b.ok && b.body?.ok) {
      summary(`✅ /health/browser: launch ${b.body.launchMs}ms, chromium ${b.body.chromiumVersion}`);
      lines.push(`Browser: launch ${b.body.launchMs}ms, ${b.body.chromiumVersion}`);
    } else {
      const detail = b.body?.error ?? `HTTP ${b.status}`;
      critical.push(`browser launch failed: ${detail}`);
      summary(`❌ /health/browser: ${detail}`);
    }
  } catch (err) {
    critical.push(`browser check errored: ${err.message}`);
    summary(`❌ /health/browser: ${err.message}`);
  }

  // 3. Library version + patch integrity?
  let installedVersion = null;
  try {
    const lib = await getJson('/health/library', { auth: true });
    if (lib.ok && lib.body?.ok) {
      installedVersion = lib.body.installedVersion;
      if (lib.body.patchesApplied) {
        summary(`✅ /health/library: ibs ${installedVersion}, retail3 patch APPLIED`);
      } else {
        critical.push(
          `ibs patch NOT applied (retail3 Discount fix is not live!) — ` +
          `targets=${JSON.stringify(lib.body.patchTargets)}`,
        );
        summary(`❌ /health/library: ibs ${installedVersion}, patch NOT applied ${JSON.stringify(lib.body.patchTargets)}`);
      }
    } else {
      const detail = lib.body?.error ?? `HTTP ${lib.status}`;
      critical.push(`library check failed: ${detail}`);
      summary(`❌ /health/library: ${detail}`);
    }
  } catch (err) {
    critical.push(`library check errored: ${err.message}`);
    summary(`❌ /health/library: ${err.message}`);
  }

  // 4. npm version drift (informational/WARN — a newer release may carry a real
  //    fix, or be a bump that would un-apply our patch on next deploy).
  if (installedVersion) {
    const latest = latestNpmVersion('israeli-bank-scrapers');
    if (latest && latest !== installedVersion) {
      warn.push(`israeli-bank-scrapers ${latest} is on npm; deployed is ${installedVersion}`);
      summary(`⚠️ npm: latest ${latest} > installed ${installedVersion}`);
      lines.push(`Library: installed ${installedVersion}, npm latest ${latest}`);
    } else if (latest) {
      summary(`✅ npm: installed ${installedVersion} is latest`);
    }
  }

  // Alert on findings. CRITICAL takes precedence; WARN goes out on its own if no
  // critical. notify() degrades gracefully if no alert channel is configured.
  if (critical.length > 0) {
    await notify({
      title: 'Light watchdog detected a CRITICAL scraper problem',
      severity: 'CRITICAL',
      lines: [...critical.map((c) => `• ${c}`), ...lines],
    });
    summary(`\n🚨 ${critical.length} critical finding(s) — alert sent.`);
  } else if (warn.length > 0) {
    await notify({
      title: 'Light watchdog: heads-up (non-critical)',
      severity: 'WARN',
      lines: [...warn.map((w) => `• ${w}`), ...lines],
    });
    summary(`\n⚠️ ${warn.length} warning(s) — alert sent.`);
  } else {
    summary('\n✅ All light checks passed. No alert.');
  }
}

main().catch((err) => {
  // Only the script ITSELF crashing reaches here — report it but still exit 0
  // so the workflow stays green (the alert is the real signal).
  console.error(`[watchdog] fatal: ${err.stack || err.message}`);
  summary(`💥 watchdog script crashed: ${err.message}`);
  notify({
    title: 'Watchdog SCRIPT crashed (not a scraper finding)',
    severity: 'CRITICAL',
    lines: [`• ${err.message}`],
  }).finally(() => process.exit(0));
});

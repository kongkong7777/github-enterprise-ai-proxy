#!/usr/bin/env node
// ghe-unswap-account — re-enable an account in tokens.json that was
// previously disabled. Mirror of ghe-swap-account.cjs.
//
// Two modes:
//
//   --from <id>     unconditionally re-enable that one account.
//                   Use this for "operator manually re-enables".
//
//   --auto          scan every disabled account and re-enable those
//                   that look auto-quota-disabled AND now have fresh
//                   quota. Drives auto-recovery from "account got
//                   disabled at end-of-month, new month started, quota
//                   reset, account should come back".
//
// Why a separate flag instead of "always auto-recover":
//
//   ghe-swap-account.cjs (now) tags every disable with `disabledReason`
//   and `disabledAt`. The auto path only flips accounts whose reason
//   starts with `quota-monitor:` — those came from automated swaps.
//   Anything else (`manual`, `revoked`, …) is left alone. Operators who
//   set disabled=true by hand and didn't fill in disabledReason also
//   get protected — auto only touches entries we're confident we set.
//
// Usage:
//   ghe-unswap-account --from alice
//   ghe-unswap-account --from alice --reason "manually re-enabled after rotation"
//   ghe-unswap-account --auto                    # quota-driven recovery
//   ghe-unswap-account --auto --pool copilot     # one pool only
//   ghe-unswap-account --auto --max-used 0.5     # only re-enable accounts with used_pct < 50%
//   ghe-unswap-account --from alice --no-reload  # write file but don't poke proxy
//   ghe-unswap-account --from alice --dry-run    # preview only
//
// After flipping the file, this script POSTs to /quota/reload (same
// endpoint ghe-swap-account uses) so the running proxy picks up the
// change without a service restart.

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(name); }

const fromId      = arg('--from');
const auto        = flag('--auto');
const reason      = arg('--reason') || (auto ? 'auto-quota-recovered' : 'manual');
const dryRun      = flag('--dry-run');
const noReload    = flag('--no-reload');
const poolFilter  = arg('--pool');
const maxUsedPct  = parseFloat(arg('--max-used') || '0.5'); // re-enable only if used_pct below this
const tokensFile  = arg('--tokens-file')
  || process.env.GHE_TOKENS_FILE
  || path.resolve(__dirname, '..', 'tokens.json');
const reloadUrl   = arg('--reload-url')
  || process.env.GHE_RELOAD_URL
  || 'http://127.0.0.1:18081/quota/reload';
const cachePath   = process.env.GHE_QUOTA_CACHE_FILE
  || path.join(os.homedir(), '.ghe', 'quota-cache.json');

if (!fromId && !auto) {
  console.error('Usage:');
  console.error('  ghe-unswap-account --from <accountId> [--reason <text>] [--dry-run] [--no-reload]');
  console.error('  ghe-unswap-account --auto [--pool <id>] [--max-used 0.5] [--dry-run]');
  process.exit(2);
}
if (!fs.existsSync(tokensFile)) {
  console.error(`tokens file not found: ${tokensFile}`);
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));

// Read quota cache for the auto path. We only re-enable accounts whose
// most-recent quota probe shows them healthy enough.
let cache = null;
try {
  if (fs.existsSync(cachePath)) cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
} catch {}
function quotaForAccount(poolId, accountId) {
  return cache?.pools?.[poolId]?.tokens?.[accountId] || null;
}

const candidates = []; // [{poolId, accountObj}]

for (const pool of (cfg.pools || [])) {
  if (poolFilter && pool.id !== poolFilter) continue;
  for (const a of (pool.accounts || [])) {
    if (!a.disabled) continue;

    if (fromId) {
      if (a.id === fromId) candidates.push({ poolId: pool.id, accountObj: a, why: 'manual' });
      continue;
    }

    // --auto mode: only flip accounts whose disable reason indicates a
    // quota-monitor swap, AND whose current cached quota is healthy.
    const reasonStr = String(a.disabledReason || '');
    const wasAutoDisabled = reasonStr.startsWith('quota-monitor:');
    if (!wasAutoDisabled) {
      // Could be: legacy entry with no reason recorded, or manually
      // disabled. Either way, skip — let the operator un-flip by hand.
      continue;
    }

    const q = quotaForAccount(pool.id, a.id);
    if (!q || q.ok === false) {
      // No fresh quota signal — proxy may have stopped probing the
      // account once it hit disabled state. Skip rather than guess.
      continue;
    }
    if (typeof q.used_pct === 'number' && q.used_pct >= maxUsedPct) {
      // The cached quota still shows pressure. Don't bring it back.
      continue;
    }
    if (q.schema === 'copilot-session' && q.remaining === 0) {
      // chat_enabled flipped off → still depleted.
      continue;
    }

    candidates.push({
      poolId: pool.id,
      accountObj: a,
      why: `auto: cached used_pct=${(q.used_pct ?? 0).toFixed(2)}, prev reason=${reasonStr || '(none)'}`,
    });
  }
}

if (!candidates.length) {
  if (fromId) {
    console.log(`[unswap] ${fromId} not found, not disabled, or didn't match --pool — no-op`);
  } else {
    console.log(`[unswap] no auto-recoverable disabled accounts (need disabledReason starting with "quota-monitor:" AND cached used_pct < ${maxUsedPct})`);
  }
  process.exit(0);
}

console.log(`[unswap] re-enabling ${candidates.length} account(s):`);
for (const c of candidates) {
  console.log(`  - ${c.accountObj.id.padEnd(24)} (pool=${c.poolId})  ${c.why}`);
}

if (dryRun) {
  console.log('[unswap] --dry-run; not modifying tokens.json');
  process.exit(0);
}

for (const c of candidates) {
  delete c.accountObj.disabled;
  delete c.accountObj.disabledReason;
  delete c.accountObj.disabledAt;
  // Tiny breadcrumb: when an operator looks at tokens.json six months
  // from now, this tells them the entry has been auto-recovered before.
  c.accountObj.lastReEnabledAt = Date.now();
  c.accountObj.lastReEnabledReason = reason;
}

const tmp = tokensFile + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
fs.renameSync(tmp, tokensFile);
console.log(`[unswap] updated ${tokensFile}`);

// Audit log — same place ghe-swap-account writes its failover entries.
try {
  const dir = path.join(os.homedir(), '.ghe');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, 'failover.log'),
    JSON.stringify({
      ts: Date.now(),
      kind: 're-enable',
      reason,
      accounts: candidates.map((c) => c.accountObj.id),
    }) + '\n', { mode: 0o600 });
} catch {}

if (noReload) { console.log('[unswap] --no-reload; skipping reload poke'); process.exit(0); }

(async () => {
  try {
    const lib = reloadUrl.startsWith('https:') ? require('node:https') : require('node:http');
    const u = new URL(reloadUrl);
    await new Promise((resolve, reject) => {
      const req = lib.request({
        method: 'POST', hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          if (res.statusCode === 200) { console.log(`[unswap] hot-reloaded via ${reloadUrl}: ${body}`); resolve(); }
          else reject(new Error(`reload returned ${res.statusCode}: ${body.slice(0,200)}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('reload timeout')); });
      req.end();
    });
  } catch (e) {
    console.warn(`[unswap] reload failed: ${e.message}`);
    process.exit(4);
  }
})();

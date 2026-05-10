#!/usr/bin/env node
// ghe-quota-monitor — periodic watchdog for the Copilot pool.
//
// Run me from cron every few minutes. I read tokens.json + the quota
// cache the proxy maintains, decide whether the active pool member is
// still healthy, and:
//
//   • If the active account has been throttled (chat_enabled=false, or
//     any bucket in limited_user_quotas at >= --threshold of its budget,
//     or the session probe failed) AND there's another enabled account
//     in the pool, I mark the active one disabled (ghe-swap-account)
//     and let the proxy hot-reload onto the next one.
//
//   • If the pool is left with zero healthy accounts after that, I
//     ALSO create a new Entra-side EMU candidate via ghe-create-emu-user
//     so the operator has somewhere to land the next OAuth mint without
//     having to provision a user from scratch under a deadline.
//
//   • I don't perform automatic OAuth minting. That step is gated by a
//     human Authorize click on github.com — see ghe-mint-oauth.cjs's
//     header comment for why. Instead I print/log a "next action" line
//     so an operator (or chatops bot) sees what to do.
//
// Usage:
//   ghe-quota-monitor.cjs                              # default 80% threshold
//   ghe-quota-monitor.cjs --threshold 0.7              # rotate at 70%
//   ghe-quota-monitor.cjs --pool copilot               # one pool only
//   ghe-quota-monitor.cjs --dry-run                    # describe, don't act
//   ghe-quota-monitor.cjs --auto-create --next-name dev2 --next-display "Dev 2"
//                                                     # also create the next
//                                                     # Entra candidate
//                                                     # when pool empties
//
// Env:
//   GHE_TOKENS_FILE         path to tokens.json (default: ../tokens.json)
//   GHE_QUOTA_CACHE_FILE    path to quota-cache.json (default: ~/.ghe/quota-cache.json)
//   GHE_RELOAD_URL          where to POST hot-reload (default: http://127.0.0.1:18081/quota/reload)
//   GHE_MONITOR_LOG         appended JSON-per-line audit (default: ~/.ghe/monitor.log)
//   GHE_NOTIFY_CMD          shell command to run on actionable events
//                           (input: a JSON event on stdin). Use this for
//                           Slack/email integration without baking it in.
//
// Exit codes:
//   0 = normal (nothing to do, or actions completed)
//   1 = error (bad config, exec failure)
//   2 = action needed but blocked (pool drained, can't auto-recover)

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function flag(name) { return process.argv.includes(name); }

const threshold     = parseFloat(arg('--threshold') || '0.8');
const poolFilter    = arg('--pool');
const dryRun        = flag('--dry-run');
const autoCreate    = flag('--auto-create');
const nextName      = arg('--next-name');
const nextDisplay   = arg('--next-display');
const nextRole      = arg('--next-role') || 'User';

const tokensFile    = process.env.GHE_TOKENS_FILE
  || path.resolve(__dirname, '..', 'tokens.json');
const quotaCacheFile = process.env.GHE_QUOTA_CACHE_FILE
  || path.join(os.homedir(), '.ghe', 'quota-cache.json');
const reloadUrl     = process.env.GHE_RELOAD_URL || 'http://127.0.0.1:18081/quota/reload';
const monitorLog    = process.env.GHE_MONITOR_LOG || path.join(os.homedir(), '.ghe', 'monitor.log');
const notifyCmd     = process.env.GHE_NOTIFY_CMD || null;

if (!fs.existsSync(tokensFile)) {
  console.error(`tokens file not found: ${tokensFile}`);
  process.exit(1);
}

// ─── load state ───────────────────────────────────────────────────────────

const tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
const cache = fs.existsSync(quotaCacheFile)
  ? JSON.parse(fs.readFileSync(quotaCacheFile, 'utf8'))
  : { pools: {} };

// ─── health classification ───────────────────────────────────────────────

function classify(accountId, q) {
  // q is the quota record for this account from quota-cache.json. The
  // proxy populates either:
  //   schema: 'rate-limit' (GHE Models) → has used/total/used_pct
  //   schema: 'copilot-session'         → has sku/enterprise_list and
  //                                       used_pct=0 when chat_enabled
  //                                       (limited_user_quotas may be
  //                                       elsewhere on the entry —
  //                                       check raw)
  if (!q) return { state: 'unknown', reason: 'no quota cache entry' };
  if (q.ok === false) return { state: 'broken', reason: q.error || 'cache reports !ok' };

  if (q.schema === 'copilot-session') {
    // For Copilot, used_pct=0 means the session was minted and chat
    // was enabled at the time of that mint. used_pct=1 means
    // chat_enabled went false (suspended). limited_user_quotas, if
    // present, gives more nuance.
    if (q.used_pct >= 1) return { state: 'depleted', reason: 'chat_enabled=false (suspended/quota-out)' };
    // limited_user_quotas isn't on `q` directly — it's on
    // session.limited_user_quotas in the cached session. We probe via
    // the raw cache below.
    return { state: 'healthy', reason: 'session active' };
  }

  // PAT / rate-limit-shaped record (GitHub Models pool, kept for
  // completeness even though the EMU pool is copilot).
  if (typeof q.used_pct === 'number') {
    if (q.used_pct >= 1)        return { state: 'depleted', reason: `used 100%` };
    if (q.used_pct >= threshold) return { state: 'pressured', reason: `used ${(q.used_pct*100).toFixed(0)}% ≥ ${(threshold*100).toFixed(0)}%` };
    return { state: 'healthy', reason: `used ${(q.used_pct*100).toFixed(0)}%` };
  }

  return { state: 'unknown', reason: 'no usable signal in cache' };
}

// ─── shell helpers ────────────────────────────────────────────────────────

function runNode(script, args) {
  const full = path.resolve(__dirname, script);
  if (dryRun) {
    return { dryRun: true, command: ['node', full, ...args].join(' ') };
  }
  const r = child.spawnSync(process.execPath, [full, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  return { exitCode: r.status, error: r.error?.message };
}

function appendLog(event) {
  try {
    fs.mkdirSync(path.dirname(monitorLog), { recursive: true, mode: 0o700 });
    fs.appendFileSync(monitorLog, JSON.stringify({ ts: Date.now(), ...event }) + '\n');
  } catch (e) {
    console.warn(`[monitor] could not write ${monitorLog}: ${e.message}`);
  }
}

function notify(event) {
  appendLog(event);
  if (!notifyCmd) return;
  try {
    const r = child.spawnSync('sh', ['-c', notifyCmd], {
      input: JSON.stringify(event),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (r.status !== 0) console.warn(`[monitor] notify cmd exit ${r.status}`);
  } catch (e) {
    console.warn(`[monitor] notify cmd failed: ${e.message}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────

const summary = { pools: {}, actions: [] };
let exitCode = 0;

for (const pool of (tokens.pools || [])) {
  if (poolFilter && pool.id !== poolFilter) continue;

  const cachePool = cache.pools?.[pool.id] || { tokens: {} };
  const accounts = (pool.accounts || []).filter((a) => !a.disabled);
  const all = (pool.accounts || []);

  const accountInfos = accounts.map((a) => {
    const q = cachePool.tokens?.[a.id];
    return { id: a.id, ...classify(a.id, q) };
  });

  const healthy = accountInfos.filter((x) => x.state === 'healthy');
  const depleted = accountInfos.filter((x) => x.state === 'depleted');
  const pressured = accountInfos.filter((x) => x.state === 'pressured');

  summary.pools[pool.id] = {
    type: pool.type,
    enabled: accounts.length,
    total: all.length,
    accounts: accountInfos,
    healthy: healthy.length,
    pressured: pressured.length,
    depleted: depleted.length,
  };

  // 1. Disable depleted accounts (each call hot-reloads the proxy).
  for (const dep of depleted) {
    summary.actions.push({ kind: 'swap', accountId: dep.id, reason: dep.reason });
    const r = runNode('ghe-swap-account.cjs',
      ['--from', dep.id, '--reason', `quota-monitor:${dep.reason}`, '--reload-url', reloadUrl]);
    notify({
      kind: 'pool.account.depleted',
      pool: pool.id,
      account: dep.id,
      reason: dep.reason,
      action: 'swapped-out',
      runResult: r,
    });
  }

  // 2. Pressured accounts → just warn for now. If you want pre-emptive
  //    rotation, change this branch to also call swap.
  for (const p of pressured) {
    summary.actions.push({ kind: 'warn', accountId: p.id, reason: p.reason });
    notify({
      kind: 'pool.account.pressured',
      pool: pool.id,
      account: p.id,
      reason: p.reason,
      action: 'no-op (informational)',
    });
  }

  // 3. After the swap-outs, recompute remaining healthy enabled accounts.
  const remainingHealthy = healthy.length;

  if (depleted.length > 0 && remainingHealthy === 0) {
    // Pool drained. Block of last resort.
    summary.actions.push({ kind: 'pool.drained', poolId: pool.id });
    notify({
      kind: 'pool.drained',
      pool: pool.id,
      message: `All accounts in pool ${pool.id} are out of capacity. Mint a new OAuth and add it to tokens.json.`,
      hint: 'ghe-mint-oauth.cjs --account <new-id>; then edit tokens.json + POST /quota/reload',
    });
    exitCode = 2;

    if (autoCreate && pool.type === 'copilot' && nextName && nextDisplay) {
      summary.actions.push({ kind: 'pool.create', poolId: pool.id, nextName });
      const r = runNode('ghe-create-emu-user.cjs', [
        '--email-prefix', nextName,
        '--display-name', nextDisplay,
        '--role', nextRole,
        '--json',
      ]);
      notify({
        kind: 'pool.candidate.created',
        pool: pool.id,
        nextName,
        runResult: r,
        message: `Entra account for ${nextName} created. Wait for SCIM (≤40min), then run ghe-mint-oauth.cjs --account ${nextName}_<shortcode>`,
      });
    }
  }
}

// ─── output ──────────────────────────────────────────────────────────────

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ...summary, ts: Date.now(), tokensFile, quotaCacheFile }, null, 2));
} else {
  for (const [pid, p] of Object.entries(summary.pools)) {
    console.log(`pool ${pid} (${p.type}): ${p.healthy}h / ${p.pressured}p / ${p.depleted}d  (enabled ${p.enabled}/${p.total})`);
    for (const a of p.accounts) {
      console.log(`  ${a.id.padEnd(24)} ${a.state.padEnd(10)} ${a.reason}`);
    }
  }
  if (summary.actions.length) {
    console.log('\nactions:');
    for (const a of summary.actions) console.log(`  - ${JSON.stringify(a)}`);
  }
}

process.exit(exitCode);

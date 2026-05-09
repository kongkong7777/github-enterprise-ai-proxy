#!/usr/bin/env node
// ghe-swap-account — disable a token in tokens.json, then poke the running
// proxy to hot-reload (no systemctl bounce). Mirror of jbai-swap-account.
//
// Usage:
//   ghe-swap-account --from <accountId>           # disable + reload
//   ghe-swap-account --from <id> --reason <why>   # tag the failover-log entry
//   ghe-swap-account --from <id> --no-reload      # write file but don't poke proxy
//   ghe-swap-account --from <id> --dry-run        # don't write at all

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(name); }

const fromId = arg('--from');
const reason = arg('--reason') || 'manual';
const dryRun = flag('--dry-run');
const noReload = flag('--no-reload');
const tokensFile = arg('--tokens-file')
  || process.env.GHE_TOKENS_FILE
  || path.resolve(__dirname, '..', 'tokens.json');
const reloadUrl = arg('--reload-url')
  || process.env.GHE_RELOAD_URL
  || 'http://127.0.0.1:18081/quota/reload';

if (!fromId) {
  console.error('Usage: ghe-swap-account --from <accountId> [--reason <text>] [--dry-run] [--no-reload]');
  process.exit(2);
}
if (!fs.existsSync(tokensFile)) {
  console.error(`tokens file not found: ${tokensFile}`);
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
let edited = false;
for (const pool of (cfg.pools || [])) {
  for (const a of (pool.accounts || [])) {
    if (a.id === fromId && !a.disabled) {
      a.disabled = true; edited = true;
    }
  }
}
if (!edited) {
  console.log(`[swap] ${fromId} not found or already disabled — no-op`);
  process.exit(0);
}
if (dryRun) {
  console.log(`[swap] --dry-run; would have disabled ${fromId} in ${tokensFile}`);
  process.exit(0);
}
const tmp = tokensFile + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
fs.renameSync(tmp, tokensFile);
console.log(`[swap] disabled ${fromId} in ${tokensFile} (reason=${reason})`);

// Append failover log
try {
  const dir = path.join(os.homedir(), '.ghe');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, 'failover.log'),
    JSON.stringify({ ts: Date.now(), accountId: fromId, reason }) + '\n', { mode: 0o600 });
} catch {}

if (noReload) { console.log('[swap] --no-reload; skipping reload poke'); process.exit(0); }

// Poke the proxy to hot-reload tokens.json
(async () => {
  try {
    const lib = reloadUrl.startsWith('https:') ? require('node:https') : require('node:http');
    const u = new URL(reloadUrl);
    await new Promise((resolve, reject) => {
      const req = lib.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode === 200) { console.log(`[swap] hot-reloaded via ${reloadUrl}: ${body}`); resolve(); }
          else reject(new Error(`reload returned ${res.statusCode}: ${body.slice(0,200)}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('reload timeout')); });
      req.end();
    });
  } catch (e) {
    console.warn(`[swap] reload failed: ${e.message}`);
    process.exit(4);
  }
})();

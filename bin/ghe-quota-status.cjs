#!/usr/bin/env node
// ghe-quota-status — read-only CLI dump of the on-disk quota cache.
// Usage:
//   ghe-quota-status              # all pools, all tokens
//   ghe-quota-status --pool foo   # one pool only
//   ghe-quota-status --json       # raw JSON

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cachePath = process.env.GHE_QUOTA_CACHE_FILE
  || path.join(os.homedir(), '.ghe', 'quota-cache.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const poolFilter = arg('--pool');
const wantJson = process.argv.includes('--json');

if (!fs.existsSync(cachePath)) {
  console.error(`quota cache not found: ${cachePath}`);
  console.error('Run the proxy at least once so it can populate the cache.');
  process.exit(2);
}

const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

if (wantJson) {
  console.log(JSON.stringify(cache, null, 2));
  process.exit(0);
}

const updated = new Date(cache.updatedAt || 0);
console.log(`updated: ${updated.toLocaleString()}`);
for (const [poolId, pool] of Object.entries(cache.pools || {})) {
  if (poolFilter && poolId !== poolFilter) continue;
  console.log(`\npool ${poolId}:`);
  for (const [tokenId, q] of Object.entries(pool.tokens || {})) {
    if (!q || !q.ok) {
      console.log(`  ${tokenId.padEnd(20)}  ERR ${q?.error || 'no data'}`);
      continue;
    }
    const pct = (q.used_pct * 100).toFixed(1).padStart(5);
    const used = String(q.used).padStart(5);
    const total = String(q.total).padStart(5);
    const rem = String(q.remaining).padStart(5);
    const models = q.models_available === false ? '  models?✗' : q.models_available === true ? '  models✓' : '';
    console.log(`  ${tokenId.padEnd(20)}  used ${used}/${total}  rem ${rem}  (${pct}%)${models}`);
  }
}

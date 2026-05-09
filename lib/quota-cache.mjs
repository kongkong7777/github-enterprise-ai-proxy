// Shared on-disk cache so the proxy main process, ghe-swap-account, and
// ghe-quota-status all see the same quota snapshot. Written by the main
// process's periodic refresh task — readers just consume it.
//
// File format:
//   {
//     "updatedAt": 1778153464000,
//     "pools": {
//       "default": {
//         "tokens": {
//           "alice":  { "ok": true,  "used": 412, "total": 5000, "used_pct": 0.0824, "remaining": 4588, "queriedAt": 1778153464000 },
//           "bob":    { "ok": true,  "used": 4998, "total": 5000, "used_pct": 0.9996, "remaining": 2,  "queriedAt": 1778153464000 },
//           "broken": { "ok": false, "error": "HTTP 401",  "queriedAt": 1778153464000 }
//         }
//       }
//     }
//   }

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const QUOTA_CACHE_PATH = process.env.GHE_QUOTA_CACHE_FILE
  || join(homedir(), '.ghe', 'quota-cache.json');

export function readQuotaCache() {
  try {
    if (!existsSync(QUOTA_CACHE_PATH)) return { updatedAt: 0, pools: {} };
    const j = JSON.parse(readFileSync(QUOTA_CACHE_PATH, 'utf8'));
    if (!j || typeof j !== 'object') return { updatedAt: 0, pools: {} };
    if (!j.pools) j.pools = {};
    return j;
  } catch (e) {
    return { updatedAt: 0, pools: {}, _readError: e.message };
  }
}

export function writeQuotaCache(cache) {
  try {
    mkdirSync(dirname(QUOTA_CACHE_PATH), { recursive: true, mode: 0o700 });
    const tmp = QUOTA_CACHE_PATH + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    renameSync(tmp, QUOTA_CACHE_PATH);
    return true;
  } catch (e) {
    return false;
  }
}

export function getCachedAccountQuota(poolId, tokenId, maxAgeMs = 10 * 60 * 1000) {
  const c = readQuotaCache();
  const a = c?.pools?.[poolId]?.tokens?.[tokenId];
  if (!a) return null;
  if (typeof a.queriedAt !== 'number') return null;
  if (Date.now() - a.queriedAt > maxAgeMs) return { ...a, _stale: true };
  return a;
}

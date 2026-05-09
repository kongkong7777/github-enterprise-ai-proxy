#!/usr/bin/env node
// github-enterprise-ai-proxy
//
// OpenAI-compatible (and pass-through) proxy that fronts a pool of GitHub
// PATs against:
//   - GitHub Models       https://models.github.ai/inference/...
//   - GitHub Copilot API  https://api.githubcopilot.com/...
//   - GitHub REST         https://api.github.com/...
//
// Architecture mirrors jetbrains-enterprise-ai-proxy:
//   - tokens.json: list of pools, each with N PATs (= "accounts")
//   - per-token quota cache, refreshed every 5min via /rate_limit
//   - fill_first DESC routing with 1pp hysteresis pin
//   - hot-reload via POST /quota/reload (no systemctl bounce)
//   - /quota dashboard

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import {
  queryQuota, isQuotaHealthy, summaryLine,
} from '../lib/quota-client.mjs';
import {
  readQuotaCache, writeQuotaCache, QUOTA_CACHE_PATH,
} from '../lib/quota-cache.mjs';
import { renderQuotaDashboard } from '../lib/quota-dashboard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.GHE_PROXY_PORT || '18081', 10);
const TOKENS_FILE = process.env.GHE_TOKENS_FILE
  || path.resolve(__dirname, '..', 'tokens.json');
const QUOTA_REFRESH_MS = parseInt(process.env.GHE_QUOTA_REFRESH_MS || String(5 * 60 * 1000), 10);
const QUOTA_BURNT_THRESHOLD = parseFloat(process.env.GHE_QUOTA_BURNT_THRESHOLD || '0.95');
const ROUTING_HYSTERESIS = parseFloat(process.env.GHE_ROUTING_HYSTERESIS || '0.01');
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.GHE_UPSTREAM_TIMEOUT_MS || String(10 * 60 * 1000), 10);

// Routing targets — the path prefix → upstream mapping.
const UPSTREAMS = {
  '/v1/chat/completions':   { host: 'models.github.ai',         path: '/inference/chat/completions' },
  '/v1/embeddings':         { host: 'models.github.ai',         path: '/inference/embeddings' },
  '/v1/responses':          { host: 'models.github.ai',         path: '/inference/responses' },
  '/inference/':            { host: 'models.github.ai',         path: null }, // pass-through suffix
  '/copilot/':              { host: 'api.githubcopilot.com',    path: null },
  '/api/':                  { host: 'api.github.com',           path: null },
};

// ─── Pool config loader ───────────────────────────────────────────────────
// tokens.json shape:
//   {
//     "defaultPool": "default",
//     "pools": [
//       { "id": "default",
//         "clientKeys": ["sk-anything-clients-must-send"],
//         "accounts": [
//           { "id": "alice", "tokenFile": "~/.ghe/alice.token", "disabled": false },
//           { "id": "bob",   "token": "ghp_..." }
//         ]
//       }
//     ]
//   }
function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}
function readToken(account) {
  if (account.token) return String(account.token).trim();
  if (account.tokenFile) {
    const f = expandHome(account.tokenFile);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  }
  return '';
}
function loadProxyConfig() {
  const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  const poolsInput = Array.isArray(raw.pools) ? raw.pools : [];
  const pools = poolsInput.map((p, i) => ({
    id: p.id || `pool-${i + 1}`,
    clientKeys: Array.isArray(p.clientKeys) ? p.clientKeys.slice() : [],
    accounts: (p.accounts || []).map((a, j) => ({
      id: a.id || `account-${j + 1}`,
      token: a.token || null,
      tokenFile: a.tokenFile || null,
      disabled: !!a.disabled,
    })),
    nextIndex: 0,
    _lastSelectedId: null,
  }));
  const defaultPool = String(raw.defaultPool || raw.default || pools[0]?.id || 'default');
  const poolsById = new Map(pools.map(p => [p.id, p]));
  const poolByClientKey = new Map();
  for (const p of pools) for (const k of p.clientKeys) poolByClientKey.set(k, p);
  return { pools, poolsById, poolByClientKey, defaultPool };
}
const proxyConfig = loadProxyConfig();

function reloadProxyConfig() {
  let fresh;
  try { fresh = loadProxyConfig(); }
  catch (e) {
    console.warn(`[reload] tokens.json parse failed; keeping previous config: ${e.message}`);
    return { ok: false, error: e.message };
  }
  const oldById = new Map(proxyConfig.poolsById);
  for (const np of fresh.pools) {
    const op = oldById.get(np.id);
    if (op) {
      np._lastSelectedId = op._lastSelectedId;
      np.nextIndex = op.nextIndex || 0;
    }
  }
  proxyConfig.pools.length = 0;
  proxyConfig.pools.push(...fresh.pools);
  proxyConfig.poolsById.clear();
  for (const p of fresh.pools) proxyConfig.poolsById.set(p.id, p);
  proxyConfig.poolByClientKey.clear();
  for (const p of fresh.pools) for (const k of p.clientKeys) proxyConfig.poolByClientKey.set(k, p);
  proxyConfig.defaultPool = fresh.defaultPool;
  const newIds = new Set(fresh.pools.flatMap(p => p.accounts.map(a => a.id)));
  const oldIds = new Set([...oldById.values()].flatMap(p => p.accounts.map(a => a.id)));
  const added = [...newIds].filter(id => !oldIds.has(id));
  const removed = [...oldIds].filter(id => !newIds.has(id));
  console.log(`[reload] tokens.json reloaded — accounts now=${newIds.size} added=[${added.join(',')}] removed=[${removed.join(',')}]`);
  return { ok: true, totalAccounts: newIds.size, added, removed };
}

// ─── Quota cache + periodic refresh ───────────────────────────────────────
const accountQuotaCache = new Map(); // accountId → quota record
let lastQuotaRefreshAt = 0;
let quotaRefreshInflight = null;

async function refreshAllQuotas() {
  const queries = [];
  for (const pool of proxyConfig.pools) {
    for (const account of pool.accounts) {
      const token = readToken(account);
      if (!token) {
        accountQuotaCache.set(account.id, { ok: false, error: 'missing token', queriedAt: Date.now() });
        continue;
      }
      queries.push(
        queryQuota({ token })
          .then(q => accountQuotaCache.set(account.id, { ...q, queriedAt: Date.now() }))
          .catch(e => accountQuotaCache.set(account.id, { ok: false, error: e.message, queriedAt: Date.now() }))
      );
    }
  }
  await Promise.all(queries);
  lastQuotaRefreshAt = Date.now();
  // Persist to disk for sibling CLIs.
  const cache = { updatedAt: lastQuotaRefreshAt, pools: {} };
  for (const pool of proxyConfig.pools) {
    cache.pools[pool.id] = { tokens: {} };
    for (const account of pool.accounts) {
      cache.pools[pool.id].tokens[account.id] = accountQuotaCache.get(account.id) || null;
    }
  }
  writeQuotaCache(cache);
  return [...accountQuotaCache.values()].filter(q => q?.ok).length;
}

async function ensureQuotaRefresh({ force = false } = {}) {
  if (quotaRefreshInflight) return quotaRefreshInflight;
  if (!force && Date.now() - lastQuotaRefreshAt < QUOTA_REFRESH_MS) return 0;
  quotaRefreshInflight = refreshAllQuotas().finally(() => { quotaRefreshInflight = null; });
  return quotaRefreshInflight;
}

// ─── Routing ──────────────────────────────────────────────────────────────
function resolveAccount(req, pool) {
  const enabled = pool.accounts.filter(a => !a.disabled);
  if (!enabled.length) {
    const e = new Error(`pool "${pool.id}" has no enabled accounts`);
    e.status = 503; throw e;
  }
  let candidates = enabled.filter((account) => {
    const q = accountQuotaCache.get(account.id);
    if (!q || !q.ok) return true;
    return q.used_pct < QUOTA_BURNT_THRESHOLD;
  });
  if (!candidates.length) candidates = enabled;
  const strategy = process.env.GHE_ROUTING_STRATEGY || 'fill_first';
  if (strategy === 'random') return candidates[Math.floor(Math.random() * candidates.length)];
  if (strategy === 'round_robin') {
    const a = candidates[pool.nextIndex % candidates.length];
    pool.nextIndex = (pool.nextIndex + 1) % candidates.length;
    return a;
  }
  // fill_first: default DESC — finish off the most-used PAT before opening a fresh one.
  const fillDir = (process.env.GHE_FILL_DIRECTION || 'desc').toLowerCase();
  const sorted = candidates.slice().sort((a, b) => {
    const aP = accountQuotaCache.get(a.id)?.used_pct ?? 0.5;
    const bP = accountQuotaCache.get(b.id)?.used_pct ?? 0.5;
    if (aP !== bP) return fillDir === 'asc' ? aP - bP : bP - aP;
    return a.id.localeCompare(b.id);
  });
  let pick = sorted[0];
  const pinnedId = pool._lastSelectedId;
  if (pinnedId) {
    const pinned = sorted.find(a => a.id === pinnedId);
    if (pinned) {
      const pinnedPct = accountQuotaCache.get(pinnedId)?.used_pct ?? 0.5;
      const topPct = accountQuotaCache.get(sorted[0].id)?.used_pct ?? 0.5;
      const drift = fillDir === 'asc' ? pinnedPct - topPct : topPct - pinnedPct;
      if (drift < ROUTING_HYSTERESIS) pick = pinned;
    }
  }
  pool._lastSelectedId = pick.id;
  return pick;
}

function predictRoutingTarget(pool) {
  const enabled = pool.accounts.filter(a => !a.disabled);
  if (!enabled.length) return null;
  let candidates = enabled.filter(a => {
    const q = accountQuotaCache.get(a.id);
    if (!q || !q.ok) return true;
    return q.used_pct < QUOTA_BURNT_THRESHOLD;
  });
  if (!candidates.length) candidates = enabled;
  const fillDir = (process.env.GHE_FILL_DIRECTION || 'desc').toLowerCase();
  const sorted = candidates.slice().sort((a, b) => {
    const aP = accountQuotaCache.get(a.id)?.used_pct ?? 0.5;
    const bP = accountQuotaCache.get(b.id)?.used_pct ?? 0.5;
    if (aP !== bP) return fillDir === 'asc' ? aP - bP : bP - aP;
    return a.id.localeCompare(b.id);
  });
  if (!sorted.length) return null;
  const pinnedId = pool._lastSelectedId;
  if (pinnedId) {
    const pinned = sorted.find(a => a.id === pinnedId);
    if (pinned) {
      const pinnedPct = accountQuotaCache.get(pinnedId)?.used_pct ?? 0.5;
      const topPct = accountQuotaCache.get(sorted[0].id)?.used_pct ?? 0.5;
      const drift = fillDir === 'asc' ? pinnedPct - topPct : topPct - pinnedPct;
      if (drift < ROUTING_HYSTERESIS) return pinnedId;
    }
  }
  return sorted[0].id;
}

function resolvePool(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const key = m ? m[1].trim() : (req.headers['x-api-key'] || '').trim();
  if (key) {
    const p = proxyConfig.poolByClientKey.get(key);
    if (p) return p;
  }
  // Fall through to default pool when no clientKeys configured at all
  // (single-tenant deploy).
  const def = proxyConfig.poolsById.get(proxyConfig.defaultPool);
  if (def) return def;
  throw Object.assign(new Error('no matching pool for client key'), { status: 401 });
}

// ─── HTTP request handling ────────────────────────────────────────────────
function pickUpstream(urlPath) {
  for (const [prefix, target] of Object.entries(UPSTREAMS)) {
    if (urlPath.startsWith(prefix)) {
      const upstreamPath = target.path != null ? target.path : urlPath;
      return { host: target.host, path: upstreamPath };
    }
  }
  return null;
}

function writeJson(res, code, obj) {
  const body = JSON.stringify(obj);
  if (!res.headersSent) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
  }
  res.end(body);
}

function forwardRequest(req, res, body, account, token, retried = false) {
  const route = pickUpstream(req.url.split('?')[0]);
  if (!route) {
    return writeJson(res, 404, { error: { message: `no upstream mapped for path ${req.url}`, type: 'routing_error' } });
  }
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  headers.authorization = `Bearer ${token}`;
  delete headers['x-api-key'];
  headers['user-agent'] = headers['user-agent'] || 'github-enterprise-ai-proxy';

  const buf = Buffer.from(body || '');
  if (buf.length > 0) headers['content-length'] = String(buf.length);

  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstream = https.request({
    hostname: route.host,
    port: 443,
    path: route.path + search,
    method: req.method,
    headers,
    timeout: UPSTREAM_TIMEOUT_MS,
  }, (upRes) => {
    if (upRes.statusCode === 429) {
      // Rate-limited — mark this PAT burnt in cache so the next request
      // routes around it without waiting for the periodic refresh.
      const prev = accountQuotaCache.get(account.id);
      accountQuotaCache.set(account.id, {
        ...(prev || {}),
        ok: true,
        used: prev?.total || 1,
        total: prev?.total || 1,
        remaining: 0,
        used_pct: 1.001,
        queriedAt: Date.now(),
        _from429: true,
      });
      console.log(`[quota-aware] ${account.id} returned 429; marked burnt in cache`);
    }
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error(`upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`)));
  upstream.on('error', (err) => {
    if (!res.headersSent) writeJson(res, 502, { error: { message: err.message, type: 'upstream_error' } });
  });
  if (buf.length > 0) upstream.write(buf);
  upstream.end();
}

// ─── Auth helpers for /quota dashboard ────────────────────────────────────
const QUOTA_AUTH_RAW = (process.env.GHE_QUOTA_AUTH || '').trim();
const QUOTA_AUTH_USERS = new Map(
  QUOTA_AUTH_RAW
    ? QUOTA_AUTH_RAW.split(',').map(s => s.trim()).filter(Boolean).map(p => {
        const i = p.indexOf(':'); if (i < 0) return null;
        return [p.slice(0, i), p.slice(i + 1)];
      }).filter(Boolean)
    : []
);
const QUOTA_AUTH_REQUIRED = QUOTA_AUTH_USERS.size > 0;
function quotaAuthOK(req) {
  if (!QUOTA_AUTH_REQUIRED) return true;
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  try {
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    const i = dec.indexOf(':');
    if (i < 0) return false;
    return QUOTA_AUTH_USERS.get(dec.slice(0, i)) === dec.slice(i + 1);
  } catch { return false; }
}

function poolHealth() {
  return proxyConfig.pools.map(pool => ({
    id: pool.id,
    effectiveStrategy: process.env.GHE_ROUTING_STRATEGY || 'fill_first',
    effectiveDirection: process.env.GHE_FILL_DIRECTION || 'desc',
    currentRoutingTarget: predictRoutingTarget(pool),
    clientKeys: pool.clientKeys.length,
    accounts: pool.accounts.map(account => ({
      id: account.id,
      disabled: !!account.disabled,
      hasToken: !!readToken(account),
      quota: accountQuotaCache.get(account.id) || null,
    })),
  }));
}

// ─── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    // Health & dashboard routes
    if (p === '/health') return writeJson(res, 200, { ok: true, pools: poolHealth(), updatedAt: lastQuotaRefreshAt });
    if (p === '/quota.json') {
      if (!quotaAuthOK(req)) return writeJson(res, 401, { error: 'authentication required' });
      return writeJson(res, 200, { service: 'github-enterprise-ai-proxy', updatedAt: lastQuotaRefreshAt, pools: poolHealth() });
    }
    if (p === '/quota') {
      if (!quotaAuthOK(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ghe-quota"' });
        return res.end('authentication required');
      }
      const html = renderQuotaDashboard({ pools: poolHealth(), updatedAt: lastQuotaRefreshAt });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (p === '/quota/refresh' && req.method === 'POST') {
      if (!quotaAuthOK(req)) return writeJson(res, 401, { error: 'authentication required' });
      try { await ensureQuotaRefresh({ force: true }); }
      catch (e) { return writeJson(res, 500, { ok: false, error: e.message }); }
      return writeJson(res, 200, { ok: true, refreshedAt: lastQuotaRefreshAt });
    }
    if (p === '/quota/reload' && req.method === 'POST') {
      if (!quotaAuthOK(req)) return writeJson(res, 401, { error: 'authentication required' });
      const r = reloadProxyConfig();
      if (r.ok) ensureQuotaRefresh({ force: true }).catch(() => {});
      return writeJson(res, r.ok ? 200 : 500, r);
    }

    // Forwarding routes — collect body, route via pool.
    let pool;
    try { pool = resolvePool(req); }
    catch (e) { return writeJson(res, e.status || 401, { error: { message: e.message, type: 'auth_error' } }); }
    let account, token;
    try {
      account = resolveAccount(req, pool);
      token = readToken(account);
      if (!token) throw Object.assign(new Error(`account "${account.id}" has no token`), { status: 503 });
    } catch (e) {
      return writeJson(res, e.status || 503, { error: { message: e.message, type: 'routing_error' } });
    }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      forwardRequest(req, res, body, account, token);
    });
    req.on('error', e => writeJson(res, 400, { error: { message: e.message, type: 'request_error' } }));
  } catch (e) {
    if (!res.headersSent) writeJson(res, 500, { error: { message: e.message, type: 'internal_error' } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[github-enterprise-ai-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[github-enterprise-ai-proxy] tokens file: ${TOKENS_FILE}`);
  console.log(`[github-enterprise-ai-proxy] pools: ${proxyConfig.pools.map(p => `${p.id}:${p.accounts.length}`).join(' ')}`);
  // Initial quota sweep
  ensureQuotaRefresh({ force: true })
    .then((n) => console.log(`[quota-refresh] initial sweep: ${n} of ${[...accountQuotaCache.keys()].length} accounts ok`))
    .catch((e) => console.warn(`[quota-refresh] initial sweep failed: ${e.message}`));
});

// Periodic refresh
setInterval(() => ensureQuotaRefresh().catch((e) => console.warn(`[quota-refresh] periodic failed: ${e.message}`)), QUOTA_REFRESH_MS);

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
import {
  getCopilotSession, refreshCopilotSession, copilotSessionMetadata,
  copilotSessionToQuotaRecord, copilotInferenceHeaders,
  getCopilotUserInfo, copilotUserInfoMetadata,
  parseQuotaHeadersFromResponse, applyQuotaHeadersToRecord,
} from '../lib/copilot-session.mjs';
import {
  recordRequest, extractUsageFromBody,
  getUsageSnapshot, premiumQuotaFromSession,
} from '../lib/copilot-usage.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.GHE_PROXY_PORT || '18081', 10);
const TOKENS_FILE = process.env.GHE_TOKENS_FILE
  || path.resolve(__dirname, '..', 'tokens.json');
// Public-facing path prefix when the dashboard is reverse-proxied behind a
// path-rewriting nginx (e.g. `https://example.com/ghe-quota/...` → here's
// `/quota/...`). The dashboard JS prepends this to its fetch() URLs so the
// "立即刷新" / 切换走 / 启用 buttons work end-to-end. Empty string =
// directly mounted at /, no rewrite (default).
const PUBLIC_BASE_PATH = (process.env.GHE_PUBLIC_BASE_PATH || '').replace(/\/+$/, '');
const QUOTA_REFRESH_MS = parseInt(process.env.GHE_QUOTA_REFRESH_MS || String(5 * 60 * 1000), 10);
const QUOTA_BURNT_THRESHOLD = parseFloat(process.env.GHE_QUOTA_BURNT_THRESHOLD || '0.95');
const QUOTA_PROACTIVE_SWAP_AT = parseFloat(process.env.GHE_QUOTA_PROACTIVE_SWAP_AT || '0.9');
const ROUTING_HYSTERESIS = parseFloat(process.env.GHE_ROUTING_HYSTERESIS || '0.01');

// ─── Per-account quota cap (parity with jbai-proxy `usedPctCap`) ─────────
// tokens.json `accounts[].usedPctCap` may set a per-account ceiling that's
// stricter than QUOTA_BURNT_THRESHOLD. Use case: keep one account's
// premium-requests usage below 50% to leave headroom for end-of-cycle
// surges, or to honour a "shared seat at 50%" policy. Values must be in
// (0, 1]; out-of-range values fall back to the global threshold.
function accountBurntCap(account) {
  const v = account?.usedPctCap;
  if (typeof v === 'number' && v > 0 && v <= 1) return v;
  return QUOTA_BURNT_THRESHOLD;
}
function accountProactiveCap(account) {
  const burnt = accountBurntCap(account);
  return Math.min(QUOTA_PROACTIVE_SWAP_AT, Math.max(0.05, burnt - 0.05));
}
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.GHE_UPSTREAM_TIMEOUT_MS || String(10 * 60 * 1000), 10);

// Enterprise-level Copilot license probe. Optional — enabled when
// GHE_COPILOT_ADMIN_PAT is set. Surfaces "X seats / Y total" on /quota.json
// so operators don't have to log into the GitHub UI to know seat usage.
// Refreshed on the same cadence as the per-account session probe.
const ENTERPRISE_SLUG = process.env.GHE_EMU_ENTERPRISE_SLUG || 'carizon-gh';
const COPILOT_ADMIN_PAT = process.env.GHE_COPILOT_ADMIN_PAT || '';
let lastEnterpriseRefreshAt = 0;
let lastEnterpriseInfo = null;     // null = never queried; { ok: true, … } | { ok: false, error }

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
//       { "id": "models",
//         "type": "models",                           // default
//         "clientKeys": ["sk-anything-clients-must-send"],
//         "accounts": [
//           { "id": "alice", "tokenFile": "~/.ghe/alice.token", "disabled": false },
//           { "id": "bob",   "token": "ghp_..." }
//         ]
//       },
//       { "id": "copilot",
//         "type": "copilot",                          // routes to Copilot
//         "clientKeys": ["sk-team-key"],
//         "accounts": [
//           // Each Copilot account holds a long-lived OAuth token (`ghu_…`
//           // / `gho_…`) obtained via device-flow against the well-known
//           // Copilot Plugin OAuth client. The proxy mints fresh ~25min
//           // session tokens per request as needed.
//           { "id": "kongkong7777", "oauthTokenFile": "~/.ghe/kongkong7777.oauth" }
//         ]
//       }
//     ]
//   }
function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p;
}
// Token lookup for "models" pools (= the legacy PAT/OAuth Bearer style).
function readToken(account) {
  if (account.token) return String(account.token).trim();
  if (account.tokenFile) {
    const f = expandHome(account.tokenFile);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  }
  return '';
}
// Token lookup for "copilot" pools — long-lived OAuth (ghu_/gho_).
function readOauthToken(account) {
  if (account.oauthToken) return String(account.oauthToken).trim();
  if (account.oauthTokenFile) {
    const f = expandHome(account.oauthTokenFile);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  }
  // Fallback: a "copilot" pool can also reuse the plain `tokenFile` slot
  // so an operator who already has a one-token deployment doesn't need
  // to rename the file.
  return readToken(account);
}
function loadProxyConfig() {
  const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  const poolsInput = Array.isArray(raw.pools) ? raw.pools : [];
  const pools = poolsInput.map((p, i) => ({
    id: p.id || `pool-${i + 1}`,
    type: (p.type || 'models').toLowerCase(),
    clientKeys: Array.isArray(p.clientKeys) ? p.clientKeys.slice() : [],
    accounts: (p.accounts || []).map((a, j) => {
      const out = {
        id: a.id || `account-${j + 1}`,
        token: a.token || null,
        tokenFile: a.tokenFile || null,
        oauthToken: a.oauthToken || null,
        oauthTokenFile: a.oauthTokenFile || null,
        disabled: !!a.disabled,
      };
      // Per-account quota cap. Validate (0, 1]; out-of-range falls back
      // to the global threshold via accountBurntCap().
      if (typeof a.usedPctCap === 'number' && a.usedPctCap > 0 && a.usedPctCap <= 1) {
        out.usedPctCap = a.usedPctCap;
      }
      // Preserve quota-monitor bookkeeping (parity with jbai-proxy):
      // these fields are written by ghe-swap-account / ghe-unswap-account
      // so the bidirectional recovery loop knows whether a `disabled: true`
      // came from the monitor (auto-recover when cap drops) or from a
      // human (leave it alone).
      if (typeof a.disabledReason === 'string') out.disabledReason = a.disabledReason;
      if (typeof a.disabledAt === 'number') out.disabledAt = a.disabledAt;
      if (typeof a.lastReEnabledAt === 'number') out.lastReEnabledAt = a.lastReEnabledAt;
      if (typeof a.lastReEnabledReason === 'string') out.lastReEnabledReason = a.lastReEnabledReason;
      return out;
    }),
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

// ─── Manual ops helper (used by /quota/swap and /quota/enable) ──────────
// Spawns one of the bin/ghe-*.cjs CLIs and resolves once it exits. We
// don't fire-and-forget like the legacy /failover path because the HTTP
// caller wants to know if the swap landed before the response returns.
function runManualOp(scriptName, args, { timeoutMs = 30_000 } = {}) {
  const scriptPath = path.resolve(__dirname, scriptName);
  if (!fs.existsSync(scriptPath)) {
    return Promise.reject(new Error(`script missing: ${scriptPath}`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${scriptName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0 || code === 2) {
        // exit 2 from the unswap script means "nothing to do" — also OK.
        resolve({ code, stdout: out, stderr: err });
      } else {
        reject(new Error(`${scriptName} exit ${code}: ${err.trim() || out.trim() || 'no output'}`));
      }
    });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// Apply quota snapshots embedded in SSE stream events to accountQuotaCache.
// Mirrors applyQuotaHeadersToRecord but for the JSON shape that comes from
// `response.completed.copilot_quota_snapshots`. Handles the same string-vs-
// number / -1-as-unlimited / premium_interactions-then-premium_models
// fallback rules.
function applyStreamSnapshotsToCache(accountId, snaps) {
  const prev = accountQuotaCache.get(accountId);
  const record = prev ? { ...prev } : { ok: true, schema: 'copilot-stream' };
  record.queriedAt = Date.now();
  record._fromStream = true;
  const out = { ...(record.quota_snapshots || {}) };
  for (const [bucket, s] of Object.entries(snaps || {})) {
    if (!s || typeof s !== 'object') continue;
    const entRaw = s.entitlement;
    const ent = (entRaw == null || entRaw === '') ? NaN : Number(entRaw);
    const remRaw = s.remaining;
    const rem = (remRaw == null || remRaw === '') ? NaN : Number(remRaw);
    const unlimited = !!s.unlimited || ent === -1;
    out[bucket] = {
      quota_id: bucket,
      unlimited,
      entitlement: Number.isFinite(ent) && ent !== -1 ? ent : null,
      remaining: Number.isFinite(rem) ? rem : null,
      used: (Number.isFinite(ent) && Number.isFinite(rem) && ent !== -1) ? Math.max(0, ent - rem) : null,
      used_pct: Number.isFinite(s.percent_remaining) ? Math.max(0, 1 - s.percent_remaining / 100) : null,
      overage_count: Number(s.overage_count) || 0,
      overage_permitted: !!s.overage_permitted,
      has_quota: !unlimited,
    };
  }
  record.quota_snapshots = out;

  // Promote metered bucket to top-level for routing.
  const metered = snaps?.premium_interactions || snaps?.premium_models;
  if (metered) {
    const ent = Number(metered.entitlement);
    if (ent === -1) record.unlimited = true;
    else if (Number.isFinite(ent) && ent > 0) {
      const rem = Number.isFinite(Number(metered.remaining))
        ? Number(metered.remaining)
        : Math.round(((Number(metered.percent_remaining) || 0) * ent) / 100);
      const used = Math.max(0, ent - rem);
      record.total = ent;
      record.remaining = rem;
      record.used = used;
      record.used_pct = ent > 0 ? used / ent : 0;
    }
    const resetCand = metered.reset_date || metered.quota_reset_at;
    if (resetCand) {
      const t = Date.parse(resetCand);
      if (Number.isFinite(t)) record.reset_ms = t;
    }
  }
  accountQuotaCache.set(accountId, record);
}

// ─── Quota cache + periodic refresh ───────────────────────────────────────
const accountQuotaCache = new Map(); // accountId → quota record
let lastQuotaRefreshAt = 0;
let quotaRefreshInflight = null;

async function refreshAllQuotas() {
  const queries = [];
  for (const pool of proxyConfig.pools) {
    for (const account of pool.accounts) {
      if (pool.type === 'copilot') {
        const oauth = readOauthToken(account);
        if (!oauth) {
          accountQuotaCache.set(account.id, { ok: false, error: 'missing oauthToken', queriedAt: Date.now() });
          continue;
        }
        // For Copilot pools the per-account probe is two calls in parallel:
        //   /copilot_internal/v2/token  → session metadata (chat_enabled,
        //                                  sku, expires_at, endpoints).
        //   /copilot_internal/user     → premium_interactions quota
        //                                  (entitlement / remaining /
        //                                  reset_at) — same data the
        //                                  VSCode extension polls for the
        //                                  "X% used · Resets MMM DD" UI.
        queries.push(
          Promise.all([
            getCopilotSession(account.id, oauth, { force: true }),
            getCopilotUserInfo(account.id, oauth, { force: true }).catch(e => {
              console.warn(`[user-info] ${account.id}: ${e.message}`);
              return null; // don't fail the whole probe — session is enough for routing
            }),
          ])
            .then(() => {
              const meta = copilotSessionMetadata(account.id);
              const userInfo = copilotUserInfoMetadata(account.id);
              accountQuotaCache.set(account.id, { ...copilotSessionToQuotaRecord(meta, userInfo), queriedAt: Date.now() });
            })
            .catch(e => accountQuotaCache.set(account.id, { ok: false, error: e.message, queriedAt: Date.now() }))
        );
        continue;
      }
      // Default: "models" pool — REST /rate_limit + /catalog/models probe.
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
  // Enterprise license probe (best-effort, never blocks the per-account flow).
  refreshEnterpriseLicense().catch((e) =>
    console.warn(`[license] enterprise probe failed: ${e.message}`));
  return [...accountQuotaCache.values()].filter(q => q?.ok).length;
}

// Enterprise-level Copilot seat probe. Best-effort: failures are cached
// (so /quota.json shows the actual error) but don't break per-account
// quota refresh. Skipped entirely when GHE_COPILOT_ADMIN_PAT is unset —
// the dashboard then renders a "set GHE_COPILOT_ADMIN_PAT to see seats"
// hint instead of a misleading "0 seats".
async function refreshEnterpriseLicense() {
  if (!COPILOT_ADMIN_PAT) {
    lastEnterpriseInfo = { ok: false, error: 'GHE_COPILOT_ADMIN_PAT not set', notConfigured: true };
    lastEnterpriseRefreshAt = Date.now();
    return lastEnterpriseInfo;
  }
  const url = `https://api.github.com/enterprises/${encodeURIComponent(ENTERPRISE_SLUG)}/copilot/billing`;
  let res, text;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${COPILOT_ADMIN_PAT}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-enterprise-ai-proxy',
      },
    });
    text = await res.text();
  } catch (e) {
    lastEnterpriseInfo = { ok: false, error: `network: ${e.message}` };
    lastEnterpriseRefreshAt = Date.now();
    return lastEnterpriseInfo;
  }
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    lastEnterpriseInfo = {
      ok: false,
      status: res.status,
      error: json?.message || text.slice(0, 200),
      hint: res.status === 404
        ? 'either Copilot Enterprise is not enabled, or the PAT lacks manage_billing:copilot scope'
        : (res.status === 401 || res.status === 403 ? 'PAT rejected (check manage_billing:copilot scope)' : null),
    };
    lastEnterpriseRefreshAt = Date.now();
    return lastEnterpriseInfo;
  }
  const sb = json?.seat_breakdown || {};
  lastEnterpriseInfo = {
    ok: true,
    enterprise: ENTERPRISE_SLUG,
    seats: {
      total: sb.total ?? null,
      active_this_cycle: sb.active_this_cycle ?? null,
      pending_invitation: sb.pending_invitation ?? 0,
      pending_cancellation: sb.pending_cancellation ?? 0,
      added_this_cycle: sb.added_this_cycle ?? 0,
      // Convenience field: best-effort "free" seat count. May be off when
      // pending_cancellation has not yet zeroed out.
      free: (typeof sb.total === 'number' && typeof sb.active_this_cycle === 'number')
        ? Math.max(0, sb.total - sb.active_this_cycle - (sb.pending_invitation || 0))
        : null,
    },
    seat_management_setting: json.seat_management_setting,
    public_code_suggestions: json.public_code_suggestions,
    ide_chat: json.ide_chat,
    platform_chat: json.platform_chat,
    cli: json.cli,
  };
  lastEnterpriseRefreshAt = Date.now();
  return lastEnterpriseInfo;
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
    return q.used_pct < accountBurntCap(account);
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
    return q.used_pct < accountBurntCap(a);
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

// Translate "/v1/chat/completions" etc. into the path the configured
// upstream wants. For Copilot the upstream host comes from the session
// itself — we only need the trailing path.
function copilotPathFor(reqPath) {
  // Strip a leading "/v1" or "/copilot" prefix; the rest goes verbatim.
  const stripped = reqPath
    .replace(/^\/v1\b/, '')
    .replace(/^\/copilot\b/, '');
  return stripped || '/chat/completions';
}

async function forwardRequest(req, res, body, pool, account, retried = false) {
  // Resolve { upstream host, upstream path, auth header, extra headers } based
  // on pool type.
  const reqPathOnly = req.url.split('?')[0];
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  let upstreamHost, upstreamPath, authValue, extraHeaders = {};

  if (pool.type === 'copilot') {
    const oauth = readOauthToken(account);
    if (!oauth) {
      return writeJson(res, 503, { error: { message: `account "${account.id}" has no oauthToken`, type: 'config_error' } });
    }
    let session;
    try {
      session = await getCopilotSession(account.id, oauth, { force: retried });
    } catch (e) {
      return writeJson(res, e.status || 502, { error: { message: `copilot session refresh failed: ${e.message}`, type: 'auth_error' } });
    }
    if (!session?.token) {
      return writeJson(res, 502, { error: { message: 'copilot session response missing token', type: 'auth_error' } });
    }
    // Pick the inference endpoint Copilot returned — for Enterprise
    // licenses this is `api.enterprise.githubcopilot.com`, individual is
    // plain `api.githubcopilot.com`.
    const apiUrl = session.endpoints?.api;
    if (!apiUrl) {
      return writeJson(res, 502, { error: { message: 'copilot session missing endpoints.api', type: 'auth_error' } });
    }
    const u = new URL(apiUrl);
    upstreamHost = u.hostname;
    upstreamPath = u.pathname.replace(/\/+$/, '') + copilotPathFor(reqPathOnly);
    authValue = `Bearer ${session.token}`;
    extraHeaders = copilotInferenceHeaders();
  } else {
    // "models" pool — passthrough Bearer + path mapping table.
    const route = pickUpstream(reqPathOnly);
    if (!route) {
      return writeJson(res, 404, { error: { message: `no upstream mapped for path ${req.url}`, type: 'routing_error' } });
    }
    const token = readToken(account);
    if (!token) {
      return writeJson(res, 503, { error: { message: `account "${account.id}" has no token`, type: 'config_error' } });
    }
    upstreamHost = route.host;
    upstreamPath = route.path;
    authValue = `Bearer ${token}`;
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers['x-api-key'];
  for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  headers.authorization = authValue;
  headers['user-agent'] = headers['user-agent'] || extraHeaders['User-Agent'] || 'github-enterprise-ai-proxy';

  const buf = Buffer.from(body || '');
  if (buf.length > 0) headers['content-length'] = String(buf.length);

  return new Promise((resolve) => {
    const upstream = https.request({
      hostname: upstreamHost,
      port: 443,
      path: upstreamPath + search,
      method: req.method,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
    }, async (upRes) => {
      if (upRes.statusCode === 401 && pool.type === 'copilot' && !retried) {
        // Session expired between our check and the call — drain the
        // upstream response, force a session refresh, and retry once.
        upRes.resume();
        try {
          await forwardRequest(req, res, body, pool, account, true);
        } catch (e) {
          if (!res.headersSent) writeJson(res, 502, { error: { message: e.message, type: 'forward_error' } });
        }
        return resolve();
      }
      if (upRes.statusCode === 429) {
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
      // Sniff `x-quota-snapshot-*` response headers BEFORE we forward
      // them: every Copilot inference response carries a fresh snapshot of
      // premium_interactions / premium_models / chat / completions. This
      // makes the cache near-realtime instead of 5-min stale (matches the
      // VSCode extension's own behaviour and parity with jbai-proxy's SSE
      // QuotaMetadata sniffing).
      try {
        const updated = applyQuotaHeadersToRecord(
          accountQuotaCache.get(account.id),
          upRes.headers,
          { resetMsHint: accountQuotaCache.get(account.id)?.reset_ms }
        );
        if (updated) accountQuotaCache.set(account.id, updated);
      } catch (e) { /* never let a sniff error break the response */ }

      // Tap the response so we can extract `usage` for the dashboard
      // without changing the byte stream the client sees.
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      let modelFromBody = null;
      try {
        const j = JSON.parse(buf.toString('utf8'));
        if (typeof j?.model === 'string') modelFromBody = j.model;
      } catch {}
      const respChunks = [];
      let respBytes = 0;
      // SSE buffer for stream-event quota sniffing. Carry over partial
      // lines across chunk boundaries.
      const ct = upRes.headers['content-type'] || '';
      const isSSE = /text\/event-stream/i.test(ct);
      let sseBuf = '';
      upRes.on('data', (chunk) => {
        respBytes += chunk.length;
        // Only buffer for usage extraction if response is plausibly small.
        if (respBytes <= 256 * 1024) respChunks.push(chunk);
        try { res.write(chunk); } catch {}
        // SSE in-flight sniffing: scan `data:` lines for embedded
        // `copilot_quota_snapshots` and update the cache mid-stream.
        if (isSSE) {
          sseBuf += chunk.toString('utf8');
          let nl;
          while ((nl = sseBuf.indexOf('\n')) >= 0) {
            const line = sseBuf.slice(0, nl).trim();
            sseBuf = sseBuf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const evt = JSON.parse(payload);
              const snaps = evt?.copilot_quota_snapshots
                || evt?.response?.copilot_quota_snapshots;
              if (snaps && typeof snaps === 'object') {
                applyStreamSnapshotsToCache(account.id, snaps);
              }
            } catch { /* not JSON, skip */ }
          }
          // Keep sseBuf bounded so a runaway non-newline stream can't
          // exhaust memory.
          if (sseBuf.length > 16 * 1024) sseBuf = sseBuf.slice(-8 * 1024);
        }
      });
      upRes.on('end', () => {
        try { res.end(); } catch {}
        const usage = respChunks.length ? extractUsageFromBody(Buffer.concat(respChunks), ct) : null;
        recordRequest(account.id, {
          status: upRes.statusCode || 0,
          model: modelFromBody,
          usage,
        });
        resolve();
      });
      upRes.on('error', () => {
        recordRequest(account.id, {
          status: upRes.statusCode || 0,
          model: modelFromBody,
          usage: null,
        });
        resolve();
      });
    });
    upstream.on('timeout', () => upstream.destroy(new Error(`upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`)));
    upstream.on('error', (err) => {
      if (!res.headersSent) writeJson(res, 502, { error: { message: err.message, type: 'upstream_error' } });
      resolve();
    });
    if (buf.length > 0) upstream.write(buf);
    upstream.end();
  });
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
    type: pool.type,
    effectiveStrategy: process.env.GHE_ROUTING_STRATEGY || 'fill_first',
    effectiveDirection: process.env.GHE_FILL_DIRECTION || 'desc',
    currentRoutingTarget: predictRoutingTarget(pool),
    clientKeys: pool.clientKeys.length,
    accounts: pool.accounts.map(account => {
      const session = pool.type === 'copilot' ? copilotSessionMetadata(account.id) : null;
      const premium = pool.type === 'copilot' ? premiumQuotaFromSession(session) : null;
      const userInfo = pool.type === 'copilot' ? copilotUserInfoMetadata(account.id) : null;
      const burntCap = accountBurntCap(account);
      const proactiveCap = accountProactiveCap(account);
      const hasOverride = typeof account.usedPctCap === 'number';
      const cachedQuota = accountQuotaCache.get(account.id) || null;
      return {
        id: account.id,
        login: userInfo?.login || null,
        disabled: !!account.disabled,
        disabledReason: account.disabledReason || null,
        disabledAt: account.disabledAt || null,
        lastReEnabledAt: account.lastReEnabledAt || null,
        lastReEnabledReason: account.lastReEnabledReason || null,
        hasToken: pool.type === 'copilot' ? !!readOauthToken(account) : !!readToken(account),
        quota: cachedQuota,
        copilotSession: session,
        copilotUserInfo: userInfo
          ? {
              login: userInfo.login,
              copilot_plan: userInfo.copilot_plan,
              access_type_sku: userInfo.access_type_sku,
              organization_login_list: userInfo.organization_login_list,
              quota_reset_date_utc: userInfo.quota_reset_date_utc,
              quota_reset_date: userInfo.quota_reset_date,
              quota_snapshots: userInfo.quota_snapshots || null,
              fetchedAt: userInfo.fetchedAt,
            }
          : null,
        premiumQuota: premium,
        usage: getUsageSnapshot(account.id),
        // Per-account cap surface (parity with jbai-proxy /quota.json).
        usedPctCap: hasOverride ? account.usedPctCap : null,
        effectiveBurntCap: burntCap,
        effectiveProactiveCap: proactiveCap,
      };
    }),
  }));
}

// ─── HTTP server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    // Health & dashboard routes
    if (p === '/health') return writeJson(res, 200, {
      ok: true,
      pools: poolHealth(),
      updatedAt: lastQuotaRefreshAt,
      enterprise: lastEnterpriseInfo
        ? { ...lastEnterpriseInfo, refreshedAt: lastEnterpriseRefreshAt }
        : null,
    });
    if (p === '/quota.json') {
      if (!quotaAuthOK(req)) return writeJson(res, 401, { error: 'authentication required' });
      return writeJson(res, 200, {
        service: 'github-enterprise-ai-proxy',
        updatedAt: lastQuotaRefreshAt,
        pools: poolHealth(),
        enterprise: lastEnterpriseInfo
          ? { ...lastEnterpriseInfo, refreshedAt: lastEnterpriseRefreshAt }
          : null,
      });
    }
    if (p === '/quota') {
      if (!quotaAuthOK(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ghe-quota"' });
        return res.end('authentication required');
      }
      const html = renderQuotaDashboard({
        pools: poolHealth(),
        updatedAt: lastQuotaRefreshAt,
        enterprise: lastEnterpriseInfo
          ? { ...lastEnterpriseInfo, refreshedAt: lastEnterpriseRefreshAt }
          : null,
        basePath: PUBLIC_BASE_PATH,
      });
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
    // Manual swap-away (parity with jbai-proxy /quota/swap). Spawns
    // ghe-swap-account.cjs against the given account id and hot-reloads.
    if (p === '/quota/swap' && req.method === 'POST') {
      if (!quotaAuthOK(req)) return writeJson(res, 401, { error: 'authentication required' });
      const id = u.searchParams.get('id') || u.searchParams.get('from');
      if (!id) return writeJson(res, 400, { ok: false, error: '?id= required' });
      const reason = u.searchParams.get('reason') || 'manual-dashboard';
      try {
        await runManualOp('ghe-swap-account.cjs', ['--from', id, '--reason', reason]);
        // Wait for the script to mutate tokens.json + then hot-reload.
        const r = reloadProxyConfig();
        ensureQuotaRefresh({ force: true }).catch(() => {});
        return writeJson(res, r.ok ? 200 : 500, { ok: r.ok, swapped: id, reload: r });
      } catch (e) {
        return writeJson(res, 500, { ok: false, error: e.message });
      }
    }
    // Manual re-enable (parity with jbai-proxy /quota/enable). Spawns
    // ghe-unswap-account.cjs against the given account id (manual mode,
    // ignores the disabledReason gate) and hot-reloads.
    if (p === '/quota/enable' && req.method === 'POST') {
      if (!quotaAuthOK(req)) return writeJson(res, 401, { error: 'authentication required' });
      const id = u.searchParams.get('id');
      if (!id) return writeJson(res, 400, { ok: false, error: '?id= required' });
      try {
        await runManualOp('ghe-unswap-account.cjs', ['--from', id]);
        const r = reloadProxyConfig();
        ensureQuotaRefresh({ force: true }).catch(() => {});
        return writeJson(res, r.ok ? 200 : 500, { ok: r.ok, enabled: id, reload: r });
      } catch (e) {
        return writeJson(res, 500, { ok: false, error: e.message });
      }
    }

    // Forwarding routes — collect body, route via pool.
    let pool;
    try { pool = resolvePool(req); }
    catch (e) { return writeJson(res, e.status || 401, { error: { message: e.message, type: 'auth_error' } }); }
    let account;
    try {
      account = resolveAccount(req, pool);
    } catch (e) {
      return writeJson(res, e.status || 503, { error: { message: e.message, type: 'routing_error' } });
    }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      try {
        await forwardRequest(req, res, body, pool, account);
      } catch (e) {
        if (!res.headersSent) writeJson(res, 502, { error: { message: e.message, type: 'forward_error' } });
      }
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

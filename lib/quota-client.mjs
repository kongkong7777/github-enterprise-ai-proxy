// GitHub Enterprise / Models quota query.
//
// Two surfaces a PAT can hit:
//
//   1. GitHub REST core rate limit
//      GET https://api.github.com/rate_limit
//      Auth: Authorization: Bearer <PAT>
//      Returns { resources: { core: { limit, used, remaining, reset } }, ... }
//      Useful as a cheap liveness + general API budget probe. NOT the same
//      pool as Copilot / Models — but a 401/403 here means the token is
//      revoked / expired / SSO-blocked, and that's exactly what we want
//      the watchdog to react to.
//
//   2. GitHub Models inference catalog ping
//      GET https://models.github.ai/catalog/models
//      Auth: Authorization: Bearer <PAT>
//      Used to confirm the token actually has Models scope before we route
//      live traffic through it. Failures here mean the token is valid for
//      REST but doesn't have `models:read` (or the org doesn't expose it).
//
// We expose `queryQuota({ token, accountId })` returning the same shape as
// the JetBrains version, so quota-cache.mjs / quota-dashboard.mjs can be
// reused unchanged.

const REQUEST_TIMEOUT_MS = 8000;
const REST_BASE = process.env.GHE_REST_BASE || 'https://api.github.com';
const MODELS_BASE = process.env.GHE_MODELS_BASE || 'https://models.github.ai';

async function fetchWithTimeout(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function queryQuota({ token, agentName = 'ghe-proxy-monitor', includeModels = true, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!token) return { ok: false, status: -1, error: 'missing token' };

  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': agentName,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1. /rate_limit — primary signal.
  let rateRes;
  try {
    rateRes = await fetchWithTimeout(`${REST_BASE}/rate_limit`, { headers }, timeoutMs);
  } catch (e) {
    return { ok: false, status: -1, error: e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message };
  }
  if (!rateRes.ok) {
    const txt = await rateRes.text().catch(() => '');
    return { ok: false, status: rateRes.status, error: txt.slice(0, 200) || `HTTP ${rateRes.status}` };
  }
  let rateJson;
  try { rateJson = await rateRes.json(); } catch { return { ok: false, status: rateRes.status, error: 'rate_limit response was not JSON' }; }

  const core = rateJson?.resources?.core || rateJson?.rate || {};
  const used = Number.isFinite(core.used) ? core.used : 0;
  const total = Number.isFinite(core.limit) ? core.limit : 0;
  const remaining = Number.isFinite(core.remaining) ? core.remaining : Math.max(0, total - used);
  const used_pct = total > 0 ? used / total : 0;

  // 2. Models catalog ping (optional, but cheap and tells us the token
  // actually has Models scope).
  let modelsAvailable = null;
  let modelsError = null;
  if (includeModels) {
    try {
      const mRes = await fetchWithTimeout(`${MODELS_BASE}/catalog/models`, { headers }, timeoutMs);
      modelsAvailable = mRes.status === 200;
      if (!modelsAvailable) {
        const txt = await mRes.text().catch(() => '');
        modelsError = txt.slice(0, 200) || `HTTP ${mRes.status}`;
      }
    } catch (e) {
      modelsAvailable = false;
      modelsError = e.message || String(e);
    }
  }

  return {
    ok: true,
    status: 200,
    used,
    total,
    remaining,
    used_pct,
    reset_ms: Number.isFinite(core.reset) ? core.reset * 1000 : null,
    models_available: modelsAvailable,
    models_error: modelsError,
    schema: 'github-rest',
  };
}

// PATs don't carry an exp claim, so we can't pre-check expiry like a JWT.
// Treat any successful queryQuota() within the last refresh window as the
// authoritative health signal.
export function tokenIsHealthy(_token) { return true; }

export function isQuotaHealthy(q, threshold = 0.95) {
  if (!q || !q.ok) return false;
  return q.used_pct < threshold;
}

export function summaryLine(accountId, q) {
  if (!q || !q.ok) {
    return `${String(accountId).padEnd(18)}  ERR ${q?.error || 'no data'}`;
  }
  const used = q.used.toString().padStart(5);
  const total = q.total.toString().padStart(5);
  const pct = (q.used_pct * 100).toFixed(1);
  const rem = q.remaining.toString().padStart(5);
  const models = q.models_available === false ? '  models?✗' : q.models_available === true ? '  models✓' : '';
  return `${String(accountId).padEnd(18)}  used ${used}/${total}  rem ${rem}  (${pct.padStart(5)}%)${models}`;
}

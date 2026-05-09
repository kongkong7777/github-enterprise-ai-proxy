// GitHub Copilot session token management.
//
// Copilot inference doesn't accept the long-lived OAuth/PAT directly. The
// flow VS Code's Copilot extension uses (and that we mirror here) is:
//
//   1. Long-lived OAuth token  (`ghu_…` or `gho_…`, obtained once via
//      device-flow against the well-known Copilot OAuth client_id
//      `Iv1.b507a08c87ecfe98` — owned & operated by GitHub).
//
//   2. Per-session token       (~1h ttl, refresh_in ~25min). Minted by
//      GET https://api.github.com/copilot_internal/v2/token
//      with the OAuth token in `Authorization: token …`. The response
//      JSON also carries the per-tenant inference endpoint
//      (`endpoints.api`), the Copilot SKU, and the enterprise IDs the
//      caller is licensed under — we surface those for the dashboard.
//
//   3. Inference call          to `<endpoints.api>/chat/completions`
//      with `Authorization: Bearer <session.token>` plus the
//      `Editor-Version` / `Editor-Plugin-Version` / `Copilot-Integration-Id`
//      / `User-Agent` headers VS Code sends. This is the only call that
//      consumes the user's Copilot quota.
//
// The cache here keeps one session per (account, oauthToken). If the
// cached session is older than `refresh_in - safetyMarginMs` we refresh
// in the background while still returning the existing token (so the
// in-flight request doesn't pay for the refresh latency).
//
// Set GHE_COPILOT_EDITOR_VERSION and GHE_COPILOT_PLUGIN_VERSION to update
// the impersonation strings if a future GitHub change starts caring about
// minimum versions; keep them looking like a real recent VS Code Copilot
// install.

const SESSION_PATH = process.env.GHE_COPILOT_SESSION_PATH || 'https://api.github.com/copilot_internal/v2/token';
const REFRESH_TIMEOUT_MS = parseInt(process.env.GHE_COPILOT_REFRESH_TIMEOUT_MS || '8000', 10);
const REFRESH_SAFETY_MS = parseInt(process.env.GHE_COPILOT_REFRESH_SAFETY_MS || String(60 * 1000), 10);

export const COPILOT_EDITOR_VERSION  = process.env.GHE_COPILOT_EDITOR_VERSION  || 'vscode/1.95.0';
export const COPILOT_PLUGIN_VERSION  = process.env.GHE_COPILOT_PLUGIN_VERSION  || 'copilot-chat/0.22.0';
export const COPILOT_INTEGRATION_ID  = process.env.GHE_COPILOT_INTEGRATION_ID  || 'vscode-chat';
export const COPILOT_USER_AGENT      = process.env.GHE_COPILOT_USER_AGENT      || 'GitHubCopilotChat/0.22.0';

// Headers every call to Copilot's inference endpoint must carry. Returned
// as a fresh object each call so callers can mutate without poisoning the
// shared default.
export function copilotInferenceHeaders() {
  return {
    'Editor-Version': COPILOT_EDITOR_VERSION,
    'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
    'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
    'User-Agent': COPILOT_USER_AGENT,
  };
}

// Refresh a session for the given OAuth token. Returns the parsed JSON or
// throws. We don't normalise the shape here — the cache stores the raw
// response so the dashboard can surface sku / enterprise_list / endpoints
// without re-fetching.
export async function refreshCopilotSession(oauthToken) {
  if (!oauthToken) throw new Error('missing oauthToken');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(SESSION_PATH, {
      method: 'GET',
      headers: {
        Authorization: `token ${oauthToken}`,
        Accept: 'application/json',
        'Editor-Version': COPILOT_EDITOR_VERSION,
        'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
        'User-Agent': COPILOT_USER_AGENT,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`copilot session refresh HTTP ${res.status}: ${txt.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// In-memory session cache, keyed by accountId. We also store the
// oauthToken used so a hot-reload that swaps the OAuth invalidates the
// session.
const sessionCache = new Map(); // accountId -> { oauthToken, session, fetchedAt, refreshInflight }

function sessionExpired(entry) {
  if (!entry?.session) return true;
  const expSec = entry.session.expires_at;
  if (typeof expSec !== 'number') return true;
  // expires_at is ABSOLUTE unix seconds; refresh once we're within the
  // safety margin of expiry.
  return Date.now() + REFRESH_SAFETY_MS >= expSec * 1000;
}

// Returns a session token usable for inference. Forces a refresh if
// expired or the OAuth token changed. Caller should pass `force=true`
// after a 401 from the inference endpoint.
export async function getCopilotSession(accountId, oauthToken, { force = false } = {}) {
  const entry = sessionCache.get(accountId);
  if (!force && entry && entry.oauthToken === oauthToken && !sessionExpired(entry)) {
    return entry.session;
  }
  // De-dup concurrent refreshes against the same accountId.
  if (entry?.refreshInflight && entry.oauthToken === oauthToken && !force) {
    return entry.refreshInflight;
  }
  const inflight = (async () => {
    const session = await refreshCopilotSession(oauthToken);
    sessionCache.set(accountId, { oauthToken, session, fetchedAt: Date.now(), refreshInflight: null });
    return session;
  })();
  sessionCache.set(accountId, { oauthToken, session: entry?.session ?? null, fetchedAt: entry?.fetchedAt ?? 0, refreshInflight: inflight });
  return inflight;
}

// Inspector for the dashboard: returns the cached session metadata
// (without exposing the actual token) so /quota.json can show sku,
// enterprise_list, endpoints, etc.
export function copilotSessionMetadata(accountId) {
  const e = sessionCache.get(accountId);
  if (!e?.session) return null;
  const s = e.session;
  return {
    sku: s.sku,
    chat_enabled: s.chat_enabled,
    expires_at_ms: typeof s.expires_at === 'number' ? s.expires_at * 1000 : null,
    refresh_in_s: s.refresh_in,
    enterprise_list: s.enterprise_list,
    organization_list: s.organization_list,
    endpoints: s.endpoints,
    fetchedAt: e.fetchedAt,
  };
}

// Map a Copilot session response → quota-shaped record for the dashboard.
// Copilot doesn't expose a numeric quota the way `/rate_limit` does, so we
// fake `used_pct` from `chat_enabled` (0 if active, 1 if disabled). The
// real fail signal is the inference call returning 401/429/403.
export function copilotSessionToQuotaRecord(metadata) {
  if (!metadata) return { ok: false, error: 'no copilot session' };
  return {
    ok: true,
    used: 0,
    total: 1,
    remaining: metadata.chat_enabled ? 1 : 0,
    used_pct: metadata.chat_enabled ? 0 : 1,
    reset_ms: metadata.expires_at_ms,
    sku: metadata.sku,
    enterprise_list: metadata.enterprise_list,
    inference_endpoint: metadata.endpoints?.api || null,
    schema: 'copilot-session',
  };
}

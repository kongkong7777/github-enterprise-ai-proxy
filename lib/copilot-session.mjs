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
// /copilot_internal/user is a richer per-user metadata endpoint that
// includes `quota_snapshots` (premium_interactions / chat / completions
// breakdowns with entitlement / remaining / reset_at) — it's what the
// VSCode Copilot extension polls to render "X% used · Resets MMM DD".
// The session endpoint returns chat_enabled, sku, endpoints and a
// session token; the user endpoint returns the actual quota numbers.
const USER_INFO_PATH = process.env.GHE_COPILOT_USER_PATH || 'https://api.github.com/copilot_internal/user';
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

// Per-user info cache (separate from sessions because /copilot_internal/user
// changes far less often than the session token expires). Holds the raw
// /copilot_internal/user response so callers can pull quota_snapshots,
// quota_reset_date_utc, copilot_plan, organization_login_list, etc.
const userInfoCache = new Map(); // accountId -> { oauthToken, info, fetchedAt }

// Fetch /copilot_internal/user. This is what the VSCode extension polls
// for the "Included premium requests N% used · Resets MMM DD" UI.
// Returns the parsed JSON or throws.
export async function fetchCopilotUserInfo(oauthToken) {
  if (!oauthToken) throw new Error('missing oauthToken');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(USER_INFO_PATH, {
      method: 'GET',
      headers: {
        Authorization: `token ${oauthToken}`,
        Accept: 'application/json',
        'Editor-Version': COPILOT_EDITOR_VERSION,
        'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
        'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
        'User-Agent': COPILOT_USER_AGENT,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`copilot user-info HTTP ${res.status}: ${txt.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function getCopilotUserInfo(accountId, oauthToken, { force = false, maxAgeMs = 60_000 } = {}) {
  const entry = userInfoCache.get(accountId);
  if (!force && entry && entry.oauthToken === oauthToken && Date.now() - entry.fetchedAt < maxAgeMs) {
    return entry.info;
  }
  const info = await fetchCopilotUserInfo(oauthToken);
  userInfoCache.set(accountId, { oauthToken, info, fetchedAt: Date.now() });
  return info;
}

export function copilotUserInfoMetadata(accountId) {
  const e = userInfoCache.get(accountId);
  return e ? { ...e.info, fetchedAt: e.fetchedAt } : null;
}

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
// enterprise_list, endpoints, etc. We also include the raw
// limited_user_quotas + reset_date — copilot-usage.mjs expects them
// in the original shape so it can compute the highest-pressure bucket.
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
    limited_user_quotas: s.limited_user_quotas || null,
    limited_user_reset_date: s.limited_user_reset_date || null,
  };
}

// Map a Copilot session response → quota-shaped record for the dashboard.
//
// History: v1 of this proxy pre-dated /copilot_internal/user discovery and
// faked used_pct off chat_enabled (0 active / 1 disabled). The session
// endpoint really does only carry chat_enabled — for actual quota numbers
// we now also fold in the /copilot_internal/user response when available.
//
// The richer record matches the JBA proxy's quota schema:
//   used / total / remaining / used_pct / reset_ms — all scoped to the
//   premium_interactions bucket (= the "Included premium requests" the
//   VSCode extension shows). Unlimited buckets get used_pct=0 + total=null.
//   Sub-bucket details (chat / completions / premium_interactions) are
//   surfaced under `quota_snapshots` so the dashboard can render them
//   independently.
export function copilotSessionToQuotaRecord(metadata, userInfo = null) {
  if (!metadata) return { ok: false, error: 'no copilot session' };

  // Default record reflecting "session is healthy, no quota signal yet".
  const base = {
    ok: true,
    used: 0,
    total: 1,
    remaining: metadata.chat_enabled ? 1 : 0,
    used_pct: metadata.chat_enabled ? 0 : 1,
    reset_ms: metadata.expires_at_ms,
    sku: metadata.sku,
    chat_enabled: metadata.chat_enabled,
    enterprise_list: metadata.enterprise_list,
    organization_list: metadata.organization_list,
    inference_endpoint: metadata.endpoints?.api || null,
    schema: 'copilot-session',
  };

  if (!userInfo) return base;

  // Pull the premium_interactions bucket — that's the one user-visible
  // metered quota for Copilot Enterprise. chat / completions are both
  // unlimited under copilot_enterprise_seat_multi_quota, but track them
  // anyway so the dashboard can show "completions: unlimited" instead of
  // hiding them.
  const snapshots = userInfo.quota_snapshots || {};
  const premium = snapshots.premium_interactions;
  const chat = snapshots.chat;
  const completions = snapshots.completions;

  // Reset date: prefer the explicit ISO string, fall back to the date-only
  // form. Both v6 and v7 of /copilot_internal/user expose at least one.
  let resetMs = null;
  if (userInfo.quota_reset_date_utc) {
    const t = Date.parse(userInfo.quota_reset_date_utc);
    if (Number.isFinite(t)) resetMs = t;
  } else if (userInfo.quota_reset_date) {
    const t = Date.parse(`${userInfo.quota_reset_date}T00:00:00Z`);
    if (Number.isFinite(t)) resetMs = t;
  }

  // Promote premium_interactions to the top-level used/total/remaining
  // because that's what the JBA-style routing logic compares against
  // QUOTA_BURNT_THRESHOLD. If the user is on a fully-unlimited tier
  // (premium.unlimited === true), used_pct stays at 0 and chat_enabled
  // remains the only burn indicator.
  if (premium && premium.unlimited === false && Number.isFinite(premium.entitlement) && premium.entitlement > 0) {
    const total = premium.entitlement;
    const remaining = Number.isFinite(premium.remaining) ? premium.remaining : Math.round((premium.percent_remaining || 0) * total / 100);
    const used = Math.max(0, total - remaining);
    base.used = used;
    base.total = total;
    base.remaining = remaining;
    base.used_pct = total > 0 ? used / total : 0;
    base.reset_ms = resetMs || base.reset_ms;
  } else if (premium && premium.unlimited === true) {
    // Genuinely unlimited bucket: still emit a 0% record so routing keeps
    // this account candidate, but flag the unlimited state for the UI.
    base.unlimited = true;
    base.reset_ms = resetMs || base.reset_ms;
  }

  base.copilot_plan = userInfo.copilot_plan || null;
  base.access_type_sku = userInfo.access_type_sku || null;
  base.assigned_date = userInfo.assigned_date || null;
  base.is_mcp_enabled = userInfo.is_mcp_enabled || null;
  base.quota_reset_at = resetMs;
  base.quota_snapshots = {
    chat: chat ? compactSnapshot(chat) : null,
    completions: completions ? compactSnapshot(completions) : null,
    premium_interactions: premium ? compactSnapshot(premium) : null,
  };
  base.schema = 'copilot-user';
  return base;
}

function compactSnapshot(s) {
  if (!s) return null;
  return {
    quota_id: s.quota_id,
    unlimited: !!s.unlimited,
    entitlement: Number.isFinite(s.entitlement) ? s.entitlement : null,
    remaining: Number.isFinite(s.remaining) ? s.remaining : null,
    used: (Number.isFinite(s.entitlement) && Number.isFinite(s.remaining)) ? Math.max(0, s.entitlement - s.remaining) : null,
    used_pct: Number.isFinite(s.percent_remaining) ? Math.max(0, 1 - s.percent_remaining / 100) : null,
    overage_count: s.overage_count || 0,
    overage_permitted: !!s.overage_permitted,
    has_quota: !!s.has_quota,
  };
}

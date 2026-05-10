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
        'X-GitHub-Api-Version': '2025-04-01',
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
//
// Header note: `Authorization: token <oauth>` (NOT `Bearer …`) — VSCode
// uses the legacy `token` scheme on this internal route. Also pins
// X-GitHub-Api-Version=2025-04-01 so a future schema change doesn't
// silently flip field names on us.
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
        'X-GitHub-Api-Version': '2025-04-01',
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

// ─── Per-request quota header sniffing ────────────────────────────────────
//
// Every Copilot inference response carries `x-quota-snapshot-*` headers
// of the form:
//   x-quota-snapshot-premium_interactions: ent=1000&rem=92&ov=0&ovPerm=false&rst=2026-06-01T00%3A00%3A00Z
//
// Reading those after each forwarded request keeps accountQuotaCache much
// fresher than the 5-min /copilot_internal/user sweep — same pattern as
// the JBA proxy's per-response SSE QuotaMetadata sniffing. Without this,
// a user could burn through their entire premium allowance between
// sweeps and the dashboard wouldn't react. With this, every successful
// (or rate-limited) request immediately updates the cache.
//
// Field map:
//   ent      monthly entitlement (number; -1 = unlimited)
//   rem      percent_remaining (0–100)
//   ov       overage_count
//   ovPerm   overage_permitted (true/false string)
//   rst      reset_at (URL-encoded ISO timestamp)

const QUOTA_HEADER_PREFIX = 'x-quota-snapshot-';

function parseQuotaHeaderValue(value) {
  if (typeof value !== 'string' || !value) return null;
  const params = new URLSearchParams(value);
  const out = {};
  if (params.has('ent')) {
    const v = Number(params.get('ent'));
    if (Number.isFinite(v)) out.entitlement = v;
  }
  if (params.has('rem')) {
    const v = Number(params.get('rem'));
    if (Number.isFinite(v)) out.percent_remaining = v;
  }
  if (params.has('ov')) {
    const v = Number(params.get('ov'));
    if (Number.isFinite(v)) out.overage_count = v;
  }
  if (params.has('ovPerm')) {
    out.overage_permitted = params.get('ovPerm') === 'true';
  }
  if (params.has('rst')) {
    out.quota_reset_at = params.get('rst');
  }
  return Object.keys(out).length ? out : null;
}

// Read all x-quota-snapshot-* headers off a Node response and return a
// `{ premium_interactions, premium_models, chat, completions }` map of
// the buckets present. Headers with unknown bucket names are ignored.
export function parseQuotaHeadersFromResponse(headers) {
  if (!headers) return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (!lk.startsWith(QUOTA_HEADER_PREFIX)) continue;
    const bucket = lk.slice(QUOTA_HEADER_PREFIX.length);
    const parsed = parseQuotaHeaderValue(Array.isArray(v) ? v[0] : v);
    if (parsed) out[bucket] = parsed;
  }
  return out;
}

// Merge a parsed quota-snapshot bundle into an existing quota record
// (the kind held by accountQuotaCache). Mutates a copy and returns it.
// `prev` is the existing record (may be null). Returns the new record
// or null if no update is warranted.
//
// Routing-relevant fields (used / total / remaining / used_pct) are only
// promoted from the *metered* bucket — premium_interactions or, falling
// back, premium_models. chat / completions buckets are tracked in
// quota_snapshots but don't feed the routing burnt-threshold check
// (they're either unlimited or session-token-gated).
export function applyQuotaHeadersToRecord(prev, headers, { resetMsHint } = {}) {
  const parsed = parseQuotaHeadersFromResponse(headers);
  if (!Object.keys(parsed).length) return null;
  const record = prev ? { ...prev } : { ok: true, schema: 'copilot-headers' };
  record.queriedAt = Date.now();
  record.ok = true;
  record._fromHeaders = true;
  const snaps = { ...(record.quota_snapshots || {}) };
  for (const [bucket, p] of Object.entries(parsed)) {
    const ent = p.entitlement;
    const rem = Number.isFinite(p.percent_remaining)
      ? Math.round((p.percent_remaining * (ent || 0)) / 100)
      : null;
    snaps[bucket] = {
      quota_id: bucket,
      unlimited: ent === -1,
      entitlement: Number.isFinite(ent) && ent !== -1 ? ent : null,
      remaining: Number.isFinite(rem) ? rem : null,
      used: (Number.isFinite(ent) && Number.isFinite(rem) && ent !== -1) ? Math.max(0, ent - rem) : null,
      used_pct: Number.isFinite(p.percent_remaining) ? Math.max(0, 1 - p.percent_remaining / 100) : null,
      overage_count: p.overage_count || 0,
      overage_permitted: !!p.overage_permitted,
      has_quota: ent !== -1,
    };
  }
  record.quota_snapshots = snaps;

  // Promote metered bucket to top-level (used/total/remaining/used_pct)
  // so resolveAccount() sees the freshest number on the very next request.
  const metered = parsed.premium_interactions || parsed.premium_models;
  if (metered) {
    const ent = metered.entitlement;
    if (ent === -1) {
      record.unlimited = true;
    } else if (Number.isFinite(ent) && ent > 0 && Number.isFinite(metered.percent_remaining)) {
      const total = ent;
      const remaining = Math.round((metered.percent_remaining * total) / 100);
      const used = Math.max(0, total - remaining);
      record.total = total;
      record.remaining = remaining;
      record.used = used;
      record.used_pct = total > 0 ? used / total : 0;
    }
    if (metered.quota_reset_at) {
      const t = Date.parse(metered.quota_reset_at);
      if (Number.isFinite(t)) record.reset_ms = t;
    } else if (resetMsHint) {
      record.reset_ms = resetMsHint;
    }
  }
  return record;
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

  // Pull the metered bucket. /copilot_internal/user puts it under
  // `premium_interactions`, but some plans (notably 2026-06+ usage-based
  // billing migration) surface it as `premium_models` instead. Prefer
  // premium_interactions when both exist (matches the VSCode extension's
  // own logic).
  const snapshots = userInfo.quota_snapshots || {};
  const premium = snapshots.premium_interactions || snapshots.premium_models;
  const chat = snapshots.chat;
  const completions = snapshots.completions;

  // Reset date: snapshot's own field wins (it's the most specific), then
  // top-level UTC, then date-only, then limited_user_reset_date as a last
  // resort. All conventions are emitted by various Copilot SKUs.
  let resetMs = null;
  const resetCandidates = [
    premium?.quota_reset_at,
    premium?.reset_date,
    userInfo.quota_reset_date_utc,
    userInfo.quota_reset_date && `${userInfo.quota_reset_date}T00:00:00Z`,
    userInfo.limited_user_reset_date && `${userInfo.limited_user_reset_date}T00:00:00Z`,
  ];
  for (const cand of resetCandidates) {
    if (!cand) continue;
    const t = Date.parse(cand);
    if (Number.isFinite(t)) { resetMs = t; break; }
  }

  // Promote the metered bucket to the top-level used/total/remaining
  // because that's what the JBA-style routing logic compares against
  // QUOTA_BURNT_THRESHOLD. Treat entitlement as a Number (some responses
  // serialise it as a string) and entitlement === -1 OR unlimited:true
  // both as "unlimited tier".
  const entRaw = premium?.entitlement;
  const ent = (entRaw == null || entRaw === '') ? NaN : Number(entRaw);
  const isUnlimited = !!premium && (premium.unlimited === true || ent === -1);
  if (premium && !isUnlimited && Number.isFinite(ent) && ent > 0) {
    const total = ent;
    // remaining can be expressed as `remaining` (count) OR derived from
    // percent_remaining. percent_remaining is the universal field so use
    // it to derive when the count is missing.
    const remaining = Number.isFinite(premium.remaining)
      ? premium.remaining
      : Math.round(((premium.percent_remaining || 0) * total) / 100);
    const used = Math.max(0, total - remaining);
    base.used = used;
    base.total = total;
    base.remaining = remaining;
    base.used_pct = total > 0 ? used / total : 0;
    base.reset_ms = resetMs || base.reset_ms;
  } else if (premium && isUnlimited) {
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
  // Coerce both fields through Number — some responses serialise
  // entitlement as a string. -1 in entitlement is a sentinel for unlimited.
  const entRaw = s.entitlement;
  const ent = (entRaw == null || entRaw === '') ? NaN : Number(entRaw);
  const remRaw = s.remaining;
  const rem = (remRaw == null || remRaw === '') ? NaN : Number(remRaw);
  const unlimited = !!s.unlimited || ent === -1;
  return {
    quota_id: s.quota_id,
    unlimited,
    entitlement: Number.isFinite(ent) && ent !== -1 ? ent : null,
    remaining: Number.isFinite(rem) ? rem : null,
    used: (Number.isFinite(ent) && Number.isFinite(rem) && ent !== -1) ? Math.max(0, ent - rem) : null,
    used_pct: Number.isFinite(s.percent_remaining) ? Math.max(0, 1 - s.percent_remaining / 100) : null,
    overage_count: Number(s.overage_count) || 0,
    overage_permitted: !!s.overage_permitted,
    has_quota: !!s.has_quota,
  };
}

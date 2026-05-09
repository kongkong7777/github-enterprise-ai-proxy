// Per-account usage accumulator for the Copilot Enterprise pool.
//
// Two distinct quota signals on Copilot Enterprise:
//
// (A) Per-request token counts. Every chat/completions response carries a
//     `usage` block:
//
//        { prompt_tokens, completion_tokens, total_tokens,
//          prompt_tokens_details: { cached_tokens },
//          completion_tokens_details: {...},
//          reasoning_tokens? }
//
//     We accumulate these per-account so the dashboard can show "what did
//     this account spend this hour / day / month" without needing the
//     admin-only billing API. Standard models (gpt-4o, gpt-4.1) bill 0
//     premium requests but tokens still flow; premium models (Claude
//     Opus 4.7, Gemini 3.1, etc.) bill 1+ premium request per call.
//
// (B) Premium-request quota. Each Copilot Enterprise seat ships with a
//     monthly cap on "premium request" calls (~300-1500 depending on
//     plan + add-ons). The `/copilot_internal/v2/token` response field
//     `limited_user_quotas` reflects the live remaining quota for the
//     authenticating user. We surface that on /quota.json so the
//     dashboard can warn before the seat gets throttled.
//
// Stats are kept in-memory only; they reset on proxy restart. That's
// fine for a single-tenant deploy — for shared deployments swap this
// for a small SQLite or Redis store.

const PREMIUM_MODEL_PATTERNS = [
  /^claude-/i,
  /^gemini-/i,
  /^gpt-5/i,        // gpt-5 / gpt-5-mini / gpt-5.2 / gpt-5.5 / gpt-5.x-codex
  /^o1/i,
  /^o3/i,
  /^grok-/i,
];

function isPremiumModel(model) {
  if (!model) return false;
  return PREMIUM_MODEL_PATTERNS.some(re => re.test(String(model)));
}

// accountId -> { tokens: { input, output, cached, reasoning, total },
//                 requests: N, premium_requests: N, errors: N,
//                 by_model: Map<model, { count, tokens_total }>,
//                 by_status: Map<status, N>,
//                 last_used_ms, last_model, started_ms }
const accountStats = new Map();

function bucket(accountId) {
  let b = accountStats.get(accountId);
  if (b) return b;
  b = {
    tokens:  { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 },
    requests: 0,
    premium_requests: 0,
    errors:   0,
    by_model: new Map(),
    by_status: new Map(),
    last_used_ms: 0,
    last_model: null,
    started_ms: Date.now(),
  };
  accountStats.set(accountId, b);
  return b;
}

// Called once per upstream response. We accept either a parsed JSON body
// (small responses) or a raw chunk we attempt to parse — SSE/streaming
// responses skip the parse and just bump a request counter; usage on
// those needs to come from the final `data: [DONE]` chunk which the
// caller can pass via `streamFinalUsage`.
export function recordRequest(accountId, { status, model, usage, streamFinalUsage }) {
  const b = bucket(accountId);
  b.requests++;
  b.last_used_ms = Date.now();
  b.last_model = model || b.last_model;
  b.by_status.set(status || 0, (b.by_status.get(status || 0) || 0) + 1);
  if (status >= 400) b.errors++;

  const m = b.by_model.get(model || '(unknown)') || { count: 0, tokens_total: 0, premium: isPremiumModel(model) };
  m.count++;
  b.by_model.set(model || '(unknown)', m);
  if (isPremiumModel(model)) b.premium_requests++;

  const u = usage || streamFinalUsage;
  if (u && typeof u === 'object') {
    const inp  = num(u.prompt_tokens) + num(u.input_tokens);
    const out  = num(u.completion_tokens) + num(u.output_tokens);
    const cached = num(u.prompt_tokens_details?.cached_tokens) + num(u.input_tokens_details?.cached_tokens);
    const reasoning = num(u.completion_tokens_details?.reasoning_tokens) + num(u.reasoning_tokens);
    const tot  = num(u.total_tokens) || (inp + out);
    b.tokens.input  += inp;
    b.tokens.output += out;
    b.tokens.cached += cached;
    b.tokens.reasoning += reasoning;
    b.tokens.total  += tot;
    m.tokens_total  += tot;
  }
}
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : 0; }

// Try to parse `usage` out of a buffered JSON response or an SSE stream.
// Anthropic-style SSE puts usage on `message_delta` events; OpenAI-style
// puts it on the final `[DONE]`-preceding chunk inside the last delta's
// `usage` field (when `stream_options: { include_usage: true }` is set).
// We do best-effort extraction; missing usage just means we count the
// request but not the tokens.
export function extractUsageFromBody(bodyBuf, contentType) {
  if (!bodyBuf || !bodyBuf.length) return null;
  const ct = String(contentType || '').toLowerCase();
  const txt = bodyBuf.toString('utf8');
  // JSON case (non-streaming).
  if (ct.includes('application/json')) {
    try {
      const j = JSON.parse(txt);
      if (j?.usage) return j.usage;
    } catch {}
    return null;
  }
  // SSE — scan for `"usage":{` blob, take the last one (final delta).
  if (ct.includes('text/event-stream') || /^data: /m.test(txt)) {
    const re = /"usage"\s*:\s*\{[^{}]*?(?:\{[^{}]*\}[^{}]*?)*\}/g;
    let last = null;
    let m;
    while ((m = re.exec(txt)) !== null) last = m[0];
    if (!last) return null;
    try {
      const wrapped = `{${last}}`;
      return JSON.parse(wrapped).usage;
    } catch {}
  }
  return null;
}

// Snapshot for the dashboard. accountId -> serialisable record.
export function getUsageSnapshot(accountId) {
  const b = accountStats.get(accountId);
  if (!b) return null;
  return {
    started_ms: b.started_ms,
    last_used_ms: b.last_used_ms,
    last_model: b.last_model,
    requests: b.requests,
    premium_requests: b.premium_requests,
    errors: b.errors,
    tokens: { ...b.tokens },
    by_model: [...b.by_model.entries()].map(([model, v]) => ({ model, count: v.count, tokens_total: v.tokens_total, premium: v.premium })),
    by_status: [...b.by_status.entries()].map(([status, count]) => ({ status, count })),
  };
}

// Translate the session response's `limited_user_quotas` into a single
// pct-used number for the dashboard. Returns null if no quota is in
// effect (= unlimited under this seat).
export function premiumQuotaFromSession(session) {
  if (!session) return null;
  const q = session.limited_user_quotas;
  if (!q || typeof q !== 'object') return null;
  // GitHub's shape (as of 2025-Q3): {
  //   chat: { entitlement, remaining },
  //   completions: { entitlement, remaining },
  //   premium_interactions: { entitlement, remaining }
  // }
  const limits = [];
  for (const key of Object.keys(q)) {
    const v = q[key];
    if (!v || typeof v !== 'object') continue;
    const ent  = num(v.entitlement);
    const rem  = num(v.remaining);
    if (ent <= 0) continue;
    limits.push({
      bucket: key,
      entitlement: ent,
      remaining: rem,
      used: Math.max(0, ent - rem),
      used_pct: ent > 0 ? (ent - rem) / ent : 0,
    });
  }
  if (!limits.length) return null;
  // Worst (highest used_pct) bucket drives the displayed value, mirroring
  // jbai-proxy's "any account ≥ threshold = quota burnt" routing rule.
  let worst = limits[0];
  for (const l of limits) if (l.used_pct > worst.used_pct) worst = l;
  return {
    buckets: limits,
    worst_bucket: worst.bucket,
    worst_used_pct: worst.used_pct,
    reset_date: session.limited_user_reset_date || null,
  };
}

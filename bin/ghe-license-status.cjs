#!/usr/bin/env node
// ghe-license-status — print Copilot Enterprise seat usage at the
// enterprise level. Answers "how many seats are we paying for, how many
// are assigned, who has them?" without anyone having to log into the
// GitHub UI.
//
// Backed by two REST endpoints:
//
//   GET /enterprises/{enterprise}/copilot/billing
//     → {
//         seat_breakdown: { total, added_this_cycle, pending_invitation,
//                           pending_cancellation, active_this_cycle, … },
//         seat_management_setting, public_code_suggestions, … }
//
//   GET /enterprises/{enterprise}/copilot/billing/seats
//     → { total_seats, seats: [{ assignee.login, assignee.id,
//                                 last_activity_at, last_activity_editor,
//                                 plan_type, … }] }
//
// Both require an admin PAT with `manage_billing:copilot` scope. A `ghu_`
// OAuth token (the kind `ghe-mint-oauth.cjs` produces) is rejected by
// these endpoints with 404 even when the user is an Enterprise Owner.
//
// Usage:
//   GHE_COPILOT_ADMIN_PAT=ghp_… ghe-license-status.cjs
//   GHE_COPILOT_ADMIN_PAT=ghp_… ghe-license-status.cjs --json
//   GHE_COPILOT_ADMIN_PAT=ghp_… ghe-license-status.cjs --seats   # full seat list
//
// Env:
//   GHE_COPILOT_ADMIN_PAT       PAT/fine-grained token with
//                               manage_billing:copilot scope. Required.
//   GHE_EMU_ENTERPRISE_SLUG     enterprise slug (default: carizon-gh)
//
// Exit codes:
//   0   ok, seat info printed
//   2   PAT missing
//   3   API error (404/401/403/etc.)

'use strict';

const enterpriseSlug = process.env.GHE_EMU_ENTERPRISE_SLUG || 'carizon-gh';
const adminPat = process.env.GHE_COPILOT_ADMIN_PAT;
const wantJson = process.argv.includes('--json');
const wantSeats = process.argv.includes('--seats');

if (!adminPat) {
  console.error('GHE_COPILOT_ADMIN_PAT not set.');
  console.error('Mint a PAT (classic) with `manage_billing:copilot` scope at:');
  console.error('  https://github.com/settings/tokens/new?scopes=manage_billing:copilot&description=ghe-license-status');
  console.error('Then: export GHE_COPILOT_ADMIN_PAT=ghp_…');
  process.exit(2);
}

async function ghRest(urlPath) {
  const url = `https://api.github.com${urlPath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${adminPat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ghe-license-status.cjs',
    },
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = new Error(`GET ${urlPath} HTTP ${res.status}: ${json?.message || text.slice(0, 200)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return json;
}

async function listAllSeats() {
  const seats = [];
  let page = 1;
  while (true) {
    const j = await ghRest(`/enterprises/${encodeURIComponent(enterpriseSlug)}/copilot/billing/seats?per_page=100&page=${page}`);
    if (!j || !Array.isArray(j.seats) || j.seats.length === 0) break;
    seats.push(...j.seats);
    if (j.seats.length < 100) break;
    page++;
    if (page > 20) break; // sanity cap, shouldn't ever hit this
  }
  return seats;
}

(async () => {
  let billing;
  try {
    billing = await ghRest(`/enterprises/${encodeURIComponent(enterpriseSlug)}/copilot/billing`);
  } catch (e) {
    if (e.status === 404) {
      console.error(`[license] HTTP 404 from /enterprises/${enterpriseSlug}/copilot/billing.`);
      console.error('  Either: (a) the PAT lacks manage_billing:copilot scope,');
      console.error('       or (b) Copilot Enterprise is not enabled on this enterprise yet.');
      console.error('  Verify with: curl -H "Authorization: Bearer $GHE_COPILOT_ADMIN_PAT" \\');
      console.error(`               https://api.github.com/enterprises/${enterpriseSlug}/copilot/billing`);
      process.exit(3);
    }
    if (e.status === 401 || e.status === 403) {
      console.error(`[license] HTTP ${e.status} — PAT rejected. Likely scope is missing manage_billing:copilot.`);
      process.exit(3);
    }
    console.error('[license]', e.message);
    process.exit(3);
  }

  let seats = null;
  if (wantSeats || wantJson) {
    try { seats = await listAllSeats(); }
    catch (e) { console.warn(`[license] could not list seats: ${e.message}`); seats = null; }
  }

  const result = {
    enterprise: enterpriseSlug,
    queriedAt: Date.now(),
    billing,
    ...(seats ? { seats } : {}),
  };

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable layout.
  const sb = billing.seat_breakdown || {};
  const total = sb.total ?? '?';
  const active = sb.active_this_cycle ?? '?';
  const pending = sb.pending_invitation ?? 0;
  const cancel = sb.pending_cancellation ?? 0;
  const added = sb.added_this_cycle ?? 0;
  const free = (typeof total === 'number' && typeof active === 'number') ? Math.max(0, total - active - pending) : '?';

  console.log(`enterprise: ${enterpriseSlug}`);
  console.log(`seats:      ${active}/${total} used  (${free} free, ${pending} pending, ${cancel} pending cancellation, +${added} this cycle)`);
  console.log(`mode:       ${billing.seat_management_setting || 'unknown'}`);
  console.log(`policy:     public_suggestions=${billing.public_code_suggestions || 'unknown'}, ide_chat=${billing.ide_chat || 'unknown'}, platform_chat=${billing.platform_chat || 'unknown'}, cli=${billing.cli || 'unknown'}`);

  if (wantSeats && seats) {
    console.log('');
    console.log('seats:');
    const fmt = (s) => {
      const last = s.last_activity_at ? new Date(s.last_activity_at).toISOString().replace('T', ' ').replace(/\..+/, 'Z') : 'never';
      const ed = s.last_activity_editor || '—';
      const plan = s.plan_type || '?';
      return `  ${(s.assignee?.login || '?').padEnd(40)}  plan=${plan.padEnd(10)} last=${last}  editor=${ed}`;
    };
    seats.sort((a, b) => (a.assignee?.login || '').localeCompare(b.assignee?.login || ''));
    for (const s of seats) console.log(fmt(s));
  }
})().catch((e) => {
  console.error('[ghe-license-status] error:', e.message);
  process.exit(1);
});

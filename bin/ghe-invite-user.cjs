#!/usr/bin/env node
// ghe-invite-user — invite a GitHub user / email into the org and (optionally)
// auto-grant a Copilot seat. The actual user-CREATE step (turning a non-
// existent email into a GitHub identity) requires SAML+SCIM, which is not
// configured by default on most GHEC enterprises — see "BIG CAVEAT" below.
//
// Usage:
//   ghe-invite-user.cjs --org kongkong-soft --email alice@example.com [--role direct_member]
//   ghe-invite-user.cjs --org kongkong-soft --user alice [--role admin]
//   ghe-invite-user.cjs --org kongkong-soft --email alice@example.com --copilot-seat
//
// Required:
//   GHE_ADMIN_TOKEN  — fine-grained PAT with org admin scopes:
//                        - Organization → Members: Read & Write
//                        - Organization → GitHub Copilot Business: Read & Write   (for --copilot-seat)
//                      OR a classic PAT with `admin:org` + `manage_billing:copilot`.
//
// BIG CAVEAT — what this DOES and does NOT do:
//
//   ✓  Sends an org invitation. The invitee receives an email and must click
//      "Accept" (GitHub does not let admins side-step this — it's a ToS thing).
//   ✓  Once they accept, optionally grants them a Copilot Enterprise seat
//      (which is what unlocks the api.enterprise.githubcopilot.com endpoint
//      under their PAT/OAuth, and what the proxy's copilot pool consumes).
//   ✗  Does NOT create a brand-new GitHub identity from a fresh email — that
//      requires SAML+SCIM provisioning, which (a) needs an IdP (Azure AD /
//      Okta / OneLogin / Ping) configured at the enterprise level and (b)
//      every provisioned user becomes an EMU (Enterprise Managed User), with
//      slightly different ToS than a normal GitHub account. Set that up via
//      Settings → Authentication security → SAML SSO.
//
// Once the invitee has accepted + has a Copilot seat, run
//   ghe-mint-oauth.cjs  --account <id>
// on a machine where they can complete a one-time browser device-flow
// login. That deposits their long-lived OAuth into ~/.ghe/<id>.oauth and
// the proxy picks them up on the next POST /quota/reload.

const https = require('node:https');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(name); }

const org      = arg('--org');
const email    = arg('--email');
const username = arg('--user');
const role     = arg('--role') || 'direct_member';   // or "admin" for org owner
const grantSeat= flag('--copilot-seat');
const dryRun   = flag('--dry-run');
const adminPat = process.env.GHE_ADMIN_TOKEN || arg('--admin-token');

if (!org || (!email && !username)) {
  console.error('Usage: ghe-invite-user.cjs --org <org-slug> (--email <addr>|--user <login>) [--role direct_member|admin] [--copilot-seat] [--dry-run]');
  console.error('Required env: GHE_ADMIN_TOKEN  (org admin token)');
  process.exit(2);
}
if (!adminPat) {
  console.error('GHE_ADMIN_TOKEN is required (or pass --admin-token).');
  process.exit(2);
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${adminPat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ghe-invite-user.cjs',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch {}
        resolve({ status: res.statusCode, body, json: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // 1. Resolve invitee_id when --user (login). For --email, we just pass email.
  let inviteeId = null;
  if (username) {
    const u = await api('GET', `/users/${encodeURIComponent(username)}`);
    if (u.status !== 200) {
      console.error(`[invite] could not resolve user ${username}: HTTP ${u.status} ${u.body.slice(0,200)}`);
      process.exit(3);
    }
    inviteeId = u.json.id;
    console.log(`[invite] resolved ${username} → user id ${inviteeId}`);
  }

  // 2. Send invitation.
  const inviteBody = inviteeId
    ? { invitee_id: inviteeId, role }
    : { email, role };
  if (dryRun) {
    console.log('[invite] --dry-run; would POST', `/orgs/${org}/invitations`, inviteBody);
  } else {
    const r = await api('POST', `/orgs/${org}/invitations`, inviteBody);
    if (r.status === 201) {
      console.log(`[invite] sent invitation: id=${r.json.id} login=${r.json.login||'-'} email=${r.json.email||'-'} role=${r.json.role}`);
    } else if (r.status === 422) {
      console.warn(`[invite] 422 — already invited or already a member? ${r.body.slice(0,200)}`);
    } else {
      console.error(`[invite] failed HTTP ${r.status}: ${r.body.slice(0,400)}`);
      process.exit(4);
    }
  }

  // 3. Auto-grant Copilot seat (only meaningful for username invites; email
  // invites can't be seated until the invitee accepts and the username is
  // known. Caller can re-run with --user once acceptance happens.)
  if (grantSeat) {
    if (!username) {
      console.warn('[copilot] --copilot-seat requires --user (Copilot seats are assigned by login). Skipping for email invite — re-run after the invitee accepts.');
    } else if (dryRun) {
      console.log('[copilot] --dry-run; would POST', `/orgs/${org}/copilot/billing/selected_users`, { selected_usernames: [username] });
    } else {
      const seat = await api('POST', `/orgs/${org}/copilot/billing/selected_users`, { selected_usernames: [username] });
      if (seat.status >= 200 && seat.status < 300) {
        const added = seat.json?.seats_created ?? '?';
        console.log(`[copilot] seat assignment: HTTP ${seat.status}, seats_created=${added}`);
      } else {
        console.error(`[copilot] seat assignment failed HTTP ${seat.status}: ${seat.body.slice(0, 400)}`);
        process.exit(5);
      }
    }
  }

  console.log('[invite] done. Next step: invitee accepts the email link, then run ghe-mint-oauth.cjs --account <id> to capture their OAuth token into ~/.ghe/<id>.oauth.');
})().catch((e) => { console.error('[invite] error:', e.message); process.exit(1); });

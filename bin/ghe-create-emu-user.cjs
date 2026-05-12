#!/usr/bin/env node
// ghe-create-emu-user — provision ONE new pool member into a GitHub
// Enterprise Managed Users (EMU) enterprise.
//
// What it does (the part you can't do in the GitHub UI):
//   1. POST /v1.0/users on Microsoft Graph         → creates the Entra
//      identity that the EMU enterprise federates against. Returns the
//      Entra object id of the new user. Without an Entra account there
//      is nothing for SCIM to provision into GitHub — this is the
//      one-and-only entry point for "add a person to my EMU".
//
//   2. POST /v1.0/servicePrincipals/{sp}/appRoleAssignedTo
//      → pins the new user to the GitHub EMU OIDC service principal
//      with the role you choose ("User", "Enterprise Owner", …). Without
//      this assignment, Entra-side provisioning evaluates to no roles
//      and SCIM rejects the user with InvalidRoleData ("The role format
//      was incorrect"). See the README for which app role GUID maps to
//      which GitHub-side capability.
//
//   3. (Optional) Poll
//      https://api.github.com/scim/v2/enterprises/<slug>/Users
//      until the new user shows up — this is how you know Entra's
//      provisioning service has actually pushed the SCIM Create. If your
//      provisioning cycle is on the default 40-minute interval, prefer
//      --no-wait and just trigger an on-demand sync from the Entra
//      portal.
//
// What this does NOT do — and why:
//   ✗  Mint a GitHub OAuth token for the new user. EMU OAuth has to come
//      via the user clicking through Entra OIDC + GitHub Authorize in
//      a real browser. There is no impersonation API and no "service
//      account" path. After SCIM creates the user, hand them off to
//      ghe-mint-oauth.cjs for the device-flow.
//
// What this CAN do (opt-in, when the right PAT is provided):
//   ✓  Assign a Copilot Enterprise seat. Pass --copilot-seat (or set
//      GHE_COPILOT_ASSIGN=1) and provide GHE_COPILOT_ADMIN_PAT (PAT or
//      fine-grained token with `manage_billing:copilot` scope on the
//      enterprise). Requires --wait-scim so we know GitHub already
//      provisioned the EMU login. Falls back to a clear "do this in
//      browser" message when the PAT is missing.
//
// Usage:
//   GRAPH_TOKEN=$(cat ~/.ghe/graph-token) ghe-create-emu-user.cjs \
//     --email-prefix alice \
//     --display-name "Alice Liu" \
//     --role User
//
//   ghe-create-emu-user.cjs --email-prefix alice --display-name "Alice Liu" --json
//   ghe-create-emu-user.cjs --email-prefix alice --display-name "Alice Liu" --wait-scim
//
// Env (precedence: env > config file > flag default):
//   GRAPH_TOKEN                  Microsoft Graph access token (must include
//                                Application.ReadWrite.All AND
//                                AppRoleAssignment.ReadWrite.All AND
//                                Directory.ReadWrite.All).
//   GHE_GRAPH_TOKEN_FILE         path to a file with just the token text
//                                (used only if GRAPH_TOKEN is unset).
//                                Default: ~/.ghe/graph-token
//   GHE_EMU_TENANT_ID            Entra tenant ID (used only for log/output).
//   GHE_EMU_SP_OBJECT_ID         GitHub EMU OIDC service principal Object ID
//                                (NOT the AppId). Override per-tenant.
//   GHE_EMU_DOMAIN               UPN suffix (e.g. kongkong.onmicrosoft.com).
//                                Defaults to the tenant's default verified
//                                domain (queried at runtime).
//   GHE_EMU_GITHUB_PAT           classic PAT with scim:enterprise scope, ONLY
//                                used by --wait-scim to poll the SCIM endpoint.
//                                Without this we skip the wait phase.
//   GHE_EMU_ENTERPRISE_SLUG      e.g. "carizon-gh", used in the SCIM URL.
//   GHE_COPILOT_ADMIN_PAT        PAT with `manage_billing:copilot` scope. When
//                                set together with --copilot-seat (or
//                                GHE_COPILOT_ASSIGN=1) this script assigns a
//                                Copilot Enterprise seat to the new EMU user
//                                AFTER SCIM has provisioned them. Without
//                                this PAT the seat step is skipped and we
//                                print the manual-assignment URL instead.
//
// App role IDs for the GitHub Enterprise Managed User (OIDC) gallery app
// — these are baked into the gallery template, same in every tenant.
//
//   User              27d9891d-2c17-4f45-a262-781a0e55c80a
//   Enterprise Owner  981df190-8801-4618-a08a-d91f6206c954
//   Billing Manager   0e338b8c-cc7f-498a-928d-ea3470d7e7e3
//   Guest Collaborator 1ebc4a02-e56c-43a6-92a5-02ee09b90824

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// ─── arg parsing ─────────────────────────────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function flag(name) { return process.argv.includes(name); }

const emailPrefix    = arg('--email-prefix');
const displayName    = arg('--display-name');
const givenName      = arg('--given-name')   || (displayName ? displayName.split(/\s+/)[0]  : null);
const familyName     = arg('--family-name')  || (displayName ? displayName.split(/\s+/).slice(1).join(' ') : null);
const role           = arg('--role') || 'User';
const domain         = arg('--domain') || process.env.GHE_EMU_DOMAIN || null;
const passwordIn     = arg('--password');
const wantJson       = flag('--json');
const waitScim       = flag('--wait-scim');
const noWait         = flag('--no-wait');
const dryRun         = flag('--dry-run');
const wantCopilotSeat = flag('--copilot-seat')
  || ['1', 'true', 'yes', 'on'].includes(String(process.env.GHE_COPILOT_ASSIGN || '').toLowerCase());
const copilotAdminPat = process.env.GHE_COPILOT_ADMIN_PAT || null;
// Optional enterprise-team auto-add. When set, the new user is added to
// this team after SCIM provisioning succeeds; the team's organization
// membership policy (typically `organization_selection_type: "all"`) plus
// the receiving org's Copilot Enterprise allowlist auto-grants the user
// a $39/1000 Enterprise seat — no /selected_users API call needed, no
// org-membership prerequisite (the team add IS the membership add).
const enterpriseTeamId = arg('--enterprise-team-id') || process.env.GHE_EMU_ENTERPRISE_TEAM_ID || null;

const APP_ROLES = {
  User:               '27d9891d-2c17-4f45-a262-781a0e55c80a',
  'Enterprise Owner': '981df190-8801-4618-a08a-d91f6206c954',
  'Billing Manager':  '0e338b8c-cc7f-498a-928d-ea3470d7e7e3',
  'Guest Collaborator':'1ebc4a02-e56c-43a6-92a5-02ee09b90824',
};

if (!emailPrefix || !displayName) {
  console.error('Usage: ghe-create-emu-user.cjs --email-prefix <prefix> --display-name "First Last" [--role User|Enterprise Owner|Billing Manager|Guest Collaborator] [--domain kongkong.onmicrosoft.com] [--password <pwd>] [--wait-scim] [--no-wait] [--copilot-seat] [--json] [--dry-run]');
  console.error('');
  console.error('Required env: GRAPH_TOKEN  or  GHE_GRAPH_TOKEN_FILE pointing at the token text.');
  console.error('Optional env: GHE_EMU_SP_OBJECT_ID, GHE_EMU_DOMAIN, GHE_EMU_ENTERPRISE_SLUG, GHE_EMU_GITHUB_PAT, GHE_COPILOT_ADMIN_PAT (for --copilot-seat)');
  process.exit(2);
}
if (!APP_ROLES[role]) {
  console.error(`Unknown --role "${role}". Must be one of: ${Object.keys(APP_ROLES).join(', ')}`);
  process.exit(2);
}

// ─── token resolution ────────────────────────────────────────────────────

// Token resolution. Three sources in precedence order:
//   1. $GRAPH_TOKEN env var (raw access token, no refresh).
//   2. $GHE_GRAPH_TOKEN_FILE / ~/.ghe/graph-token.json (mint-graph format
//      with refresh_token + expires_at_ms — auto-refresh in-process if
//      we're within 60s of expiry).
//   3. $GHE_GRAPH_TOKEN_FILE / ~/.ghe/graph-token (legacy plain text,
//      no refresh — return as-is, fail with a hint if expired).
async function loadGraphToken() {
  const env = process.env.GRAPH_TOKEN;
  if (env && env.trim()) return env.trim();

  const jsonPath = process.env.GHE_GRAPH_TOKEN_FILE
    || path.join(os.homedir(), '.ghe', 'graph-token.json');
  if (fs.existsSync(jsonPath)) {
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const refreshSafetyMs = 60 * 1000;
    if (j.expires_at_ms && Date.now() + refreshSafetyMs < j.expires_at_ms) {
      return j.access_token;
    }
    if (j.refresh_token) {
      // Refresh in-process so cron jobs never need an interactive step.
      const r = await fetch(`https://login.microsoftonline.com/${j.tenantId || 'organizations'}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: j.clientId || '14d82eec-204b-4c2f-b7e8-296a70dab67e',
          refresh_token: j.refresh_token,
          scope: 'https://graph.microsoft.com/Application.ReadWrite.All https://graph.microsoft.com/AppRoleAssignment.ReadWrite.All https://graph.microsoft.com/Directory.ReadWrite.All offline_access',
        }).toString(),
      });
      if (!r.ok) {
        const t = await r.text();
        console.error(`Graph token refresh failed HTTP ${r.status}: ${t.slice(0, 200)}`);
        console.error(`Re-mint with: ghe-mint-graph.cjs`);
        process.exit(3);
      }
      const nj = await r.json();
      const updated = {
        ...j,
        access_token: nj.access_token,
        token_type: nj.token_type,
        expires_in: nj.expires_in,
        expires_at_ms: Date.now() + (nj.expires_in * 1000),
        scope: nj.scope,
        refresh_token: nj.refresh_token || j.refresh_token,
        obtained_at: Date.now(),
      };
      const tmp = jsonPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, jsonPath);
      return nj.access_token;
    }
    if (j.access_token) return j.access_token;
  }

  const legacyPath = path.join(os.homedir(), '.ghe', 'graph-token');
  if (fs.existsSync(legacyPath)) {
    const t = fs.readFileSync(legacyPath, 'utf8').trim();
    if (t) return t;
  }

  console.error('No Graph token found. Run:');
  console.error('  ghe-mint-graph.cjs              # interactive device-flow mint (one-time)');
  console.error('Then this script (and cron jobs) will silently refresh on every call.');
  process.exit(3);
}

let graphToken = null; // set inside main() once we've awaited the resolver
const spObjectId = process.env.GHE_EMU_SP_OBJECT_ID || '1ea7b560-fe1a-4a3f-9f28-45fc39c5bce6';
const enterpriseSlug = process.env.GHE_EMU_ENTERPRISE_SLUG || 'carizon-gh';
const githubPat = process.env.GHE_EMU_GITHUB_PAT;

// ─── Graph API plumbing ──────────────────────────────────────────────────

async function graph(method, urlPath, body) {
  const url = `https://graph.microsoft.com/v1.0${urlPath}`;
  const headers = {
    Authorization: `Bearer ${graphToken}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300);
    const err = new Error(`Graph ${method} ${urlPath} HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return json;
}

// ─── default-domain auto-detect ──────────────────────────────────────────

async function pickDomain() {
  if (domain) return domain;
  const d = await graph('GET', '/domains?$select=id,isDefault,isVerified');
  const verified = (d.value || []).filter((x) => x.isVerified);
  if (!verified.length) throw new Error('no verified domains in tenant');
  const def = verified.find((x) => x.isDefault) || verified.find((x) => /\.onmicrosoft\.com$/i.test(x.id)) || verified[0];
  return def.id;
}

// ─── password generator ──────────────────────────────────────────────────

function genPassword() {
  // 16 chars, mixed-case + digits + punct, satisfies Entra default policy.
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const a = 'abcdefghjkmnpqrstuvwxyz';
  const N = '23456789';
  const P = '!@#$%&*-+=?';
  const all = A + a + N + P;
  const buf = crypto.randomBytes(16);
  let out = '';
  // ensure at least one of each class
  out += A[buf[0] % A.length];
  out += a[buf[1] % a.length];
  out += N[buf[2] % N.length];
  out += P[buf[3] % P.length];
  for (let i = 4; i < 16; i++) out += all[buf[i] % all.length];
  // shuffle
  return out.split('').sort(() => 0.5 - Math.random()).join('');
}

// ─── Copilot Enterprise seat assignment ──────────────────────────────────
//
// Two assignment paths exist with very different billing consequences:
//
//   (A) ORG-level (preferred):
//       POST /orgs/{org}/copilot/billing/selected_users
//       Seat is billed at the tier the org's Copilot subscription holds.
//       For carizon-dev (which has Copilot Enterprise attached at the
//       org level — `$39/seat` per the org settings page), this grants a
//       genuine Enterprise tier seat with 1000 premium_interactions/mo.
//       This is the path you want for paying customers.
//
//   (B) ENTERPRISE-level (legacy fallback):
//       POST /enterprises/{enterprise}/copilot/billing/selected_users
//       Seat is billed at the enterprise's subscription tier, which for
//       carizon-gh is Copilot Business ($19/seat, 300 premium/mo). This
//       path is also what GitHub falls back to when the enterprise has
//       Business but no org-level Enterprise add-on.
//
// We try (A) first if GHE_EMU_ASSIGN_ORG is set, then fall back to (B).
// Both require a PAT with `manage_billing:copilot` (admin:enterprise also
// covers it). A `ghu_` OAuth token can't do either even if the user is an
// Enterprise Owner — needs a real PAT (classic or fine-grained).
async function assignCopilotEnterpriseSeat(login) {
  if (!copilotAdminPat) {
    return {
      assigned: false,
      reason: 'GHE_COPILOT_ADMIN_PAT not set',
      manualUrl: `https://github.com/enterprises/${enterpriseSlug}/copilot/seats`,
    };
  }
  const baseHeaders = {
    Authorization: `Bearer ${copilotAdminPat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'ghe-create-emu-user.cjs',
  };

  // (A) Org-level path. Default to GHE_EMU_ASSIGN_ORG if set, otherwise the
  // single-org carizon-dev convention; pass --assign-org to override.
  const assignOrg = arg('--assign-org') || process.env.GHE_EMU_ASSIGN_ORG;
  if (assignOrg) {
    const url = `https://api.github.com/orgs/${encodeURIComponent(assignOrg)}/copilot/billing/selected_users`;
    const res = await fetch(url, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({ selected_usernames: [login] }),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (res.status === 201 || res.status === 200) {
      return {
        assigned: true,
        tier: 'enterprise', // org-level grant on an Enterprise-attached org
        response: json,
        status: res.status,
        note: `via org ${assignOrg} (Copilot Enterprise tier)`,
      };
    }
    if (res.status === 422 && /already.*assigned|already has a Copilot subscription/i.test(text)) {
      return {
        assigned: true, tier: 'enterprise', response: json, status: res.status,
        note: `via org ${assignOrg} — already had a seat`,
      };
    }
    // Soft-fall through to enterprise-level path; log the org failure so
    // the operator knows why we didn't get Enterprise tier.
    console.warn(`[copilot] org-level grant failed (HTTP ${res.status}): ${json?.message || text.slice(0, 200)}`);
    console.warn(`[copilot] falling back to enterprise-level seat (Business tier).`);
  }

  // (B) Enterprise-level fallback.
  const url = `https://api.github.com/enterprises/${encodeURIComponent(enterpriseSlug)}/copilot/billing/selected_users`;
  const res = await fetch(url, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({ selected_usernames: [login] }),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (res.status === 201 || res.status === 200) {
    return {
      assigned: true,
      tier: 'business', // enterprise-level grant tracks the enterprise subscription
      response: json,
      status: res.status,
      note: assignOrg ? 'fell back to enterprise-level (Business tier)' : 'enterprise-level (Business tier)',
    };
  }
  if (res.status === 422 && /already.*assigned|already has a Copilot subscription/i.test(text)) {
    return { assigned: true, tier: 'business', response: json, status: res.status, note: 'already had a seat' };
  }
  return {
    assigned: false,
    reason: `HTTP ${res.status}: ${json?.message || text.slice(0, 200)}`,
    status: res.status,
    manualUrl: `https://github.com/enterprises/${enterpriseSlug}/copilot/seats`,
  };
}

// ─── SCIM poll ───────────────────────────────────────────────────────────

async function waitForScimUser(targetExternalId, deadlineMs) {
  if (!githubPat) {
    console.warn('[scim-wait] GHE_EMU_GITHUB_PAT not set; skipping SCIM poll. Trigger an on-demand provision from the Entra portal to push immediately.');
    return null;
  }
  const url = `https://api.github.com/scim/v2/enterprises/${encodeURIComponent(enterpriseSlug)}/Users?filter=externalId%20eq%20%22${targetExternalId}%22`;
  while (Date.now() < deadlineMs) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubPat}`,
        Accept: 'application/scim+json',
        'User-Agent': 'ghe-create-emu-user.cjs',
      },
    });
    if (res.status === 200) {
      const j = await res.json();
      if (j.totalResults > 0 && Array.isArray(j.Resources) && j.Resources[0]) {
        return j.Resources[0];
      }
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  process.stdout.write('\n');
  return null;
}

// ─── main ────────────────────────────────────────────────────────────────

(async () => {
  graphToken = await loadGraphToken();
  const password = passwordIn || genPassword();
  const dom = await pickDomain();
  const upn = `${emailPrefix}@${dom}`;
  const expectedGithubLogin = `${emailPrefix}_${enterpriseSlug.replace(/^([a-z]+).*$/i, '$1')}`; // best-effort

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      wouldCreate: {
        userPrincipalName: upn,
        displayName,
        mailNickname: emailPrefix,
        passwordRedacted: '*'.repeat(password.length),
        appRole: role,
        appRoleId: APP_ROLES[role],
        servicePrincipalObjectId: spObjectId,
        expectedGithubLogin,
        enterpriseSlug,
      },
    }, null, 2));
    return;
  }

  // 1. Create Entra user.
  let user;
  try {
    user = await graph('POST', '/users', {
      accountEnabled: true,
      displayName,
      mailNickname: emailPrefix,
      userPrincipalName: upn,
      givenName: givenName || undefined,
      surname:  familyName || undefined,
      passwordProfile: {
        forceChangePasswordNextSignIn: true,
        password,
      },
    });
  } catch (e) {
    if (e.status === 400 && /already exists/i.test(e.message)) {
      console.warn(`[entra] user ${upn} already exists; fetching existing record`);
      user = await graph('GET', `/users/${encodeURIComponent(upn)}`);
    } else {
      throw e;
    }
  }
  console.log(`[entra] user id=${user.id}  upn=${user.userPrincipalName}  displayName=${user.displayName}`);

  // 2. Assign app role on the EMU OIDC service principal.
  try {
    const a = await graph('POST', `/servicePrincipals/${spObjectId}/appRoleAssignedTo`, {
      principalId: user.id,
      resourceId:  spObjectId,
      appRoleId:   APP_ROLES[role],
    });
    console.log(`[role]  assigned ${role} (appRoleId=${APP_ROLES[role]}) → assignmentId=${a.id}`);
  } catch (e) {
    if (e.status === 400 && /Permission being assigned was already assigned/i.test(e.message)) {
      console.warn(`[role]  user already has app role assigned (probably from a previous run) — proceeding`);
    } else {
      throw e;
    }
  }

  // 2b. Pre-register a recovery email method so the user can complete
  //     M365 first sign-in without being stopped by the tenant's SSPR
  //     registration interrupt CA policy. Without this the new user
  //     deadlocks on "Let's keep your account secure" the moment they
  //     enter their initial password — no Authenticator, no phone, no
  //     way through. Pre-registering an arbitrary email satisfies the
  //     "registered for SSPR" check and lets the user breeze through to
  //     the password-change page → GitHub SSO → OAuth Authorize. The
  //     email used is a synthetic recovery address; the user never has
  //     to receive mail there because we don't actually exercise SSPR.
  //     Requires UserAuthenticationMethod.ReadWrite.All on the Graph
  //     token (ghe-mint-graph.cjs >= 2026-05-12). Silently skipped if
  //     the scope is missing (HTTP 403) — logged as a warning so the
  //     operator can re-mint the token or do step B manually.
  let authMethodPreReg = null;
  try {
    const recoveryEmail = arg('--recovery-email') || `${emailPrefix}-recovery@${user.userPrincipalName.split('@')[1]}`;
    const a = await graph('POST', `/users/${user.id}/authentication/emailMethods`, {
      emailAddress: recoveryEmail,
    });
    authMethodPreReg = { registered: true, methodId: a.id, emailAddress: recoveryEmail };
    console.log(`[mfa]   pre-registered recovery email ${recoveryEmail} (methodId=${a.id}) — SSPR interrupt will be skipped on first sign-in`);
  } catch (e) {
    if (e.status === 403) {
      authMethodPreReg = { registered: false, reason: 'Graph token lacks UserAuthenticationMethod.ReadWrite.All' };
      console.warn(`[mfa]   skipped — Graph token doesn't have UserAuthenticationMethod.ReadWrite.All scope. Re-mint with ghe-mint-graph.cjs (>= 2026-05-12). Without this the user will hit a SSPR registration interrupt on M365 first sign-in and step B will block.`);
    } else if (e.status === 409 || /already exists|conflict/i.test(e.message || '')) {
      authMethodPreReg = { registered: true, note: 'method already existed (idempotent re-run)' };
      console.log(`[mfa]   recovery email already registered (idempotent re-run, OK)`);
    } else {
      authMethodPreReg = { registered: false, reason: `HTTP ${e.status}: ${e.message?.slice(0, 200)}` };
      console.warn(`[mfa]   pre-registration failed (HTTP ${e.status}): ${e.message?.slice(0, 200)}`);
    }
  }

  // 3. Optional SCIM poll.
  let scimUser = null;
  if (waitScim && !noWait) {
    console.log('[scim] waiting up to 10 min for SCIM provisioning to push the user to GitHub…');
    scimUser = await waitForScimUser(user.id, Date.now() + 10 * 60 * 1000);
    if (scimUser) {
      console.log(`[scim] OK  scim_id=${scimUser.id}  github userName=${scimUser.userName}`);
    } else {
      console.warn(`[scim] timed out — Entra provisioning hasn't pushed yet. Visit "On-demand provisioning" in Entra to force, or wait the next 40-min cycle.`);
    }
  }

  // 3b. SCIM userName is an email address (e.g. `dev2@baidu.ooo`) but
  //     /selected_users and /teams/{id}/memberships both want the actual
  //     EnterpriseUserAccount login (e.g. `dev2_kongkong`). They don't
  //     follow a deterministic rule — GitHub picks the shortcode based
  //     on the enterprise's display name. Resolve it via GraphQL.
  let resolvedGithubLogin = null;
  if (scimUser?.userName && githubPat) {
    try {
      const r = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubPat}`,
          'Content-Type': 'application/json',
          'User-Agent': 'ghe-create-emu-user.cjs',
        },
        body: JSON.stringify({
          query: `query($slug:String!,$q:String!){enterprise(slug:$slug){members(query:$q,first:5){nodes{__typename ... on EnterpriseUserAccount{login}}}}}`,
          variables: { slug: enterpriseSlug, q: emailPrefix },
        }),
      });
      const j = await r.json();
      const nodes = j?.data?.enterprise?.members?.nodes || [];
      // Match by mailNickname prefix (`dev2`) in the login (`dev2_kongkong`).
      const hit = nodes.find(n => n.login && n.login.toLowerCase().startsWith(emailPrefix.toLowerCase() + '_'))
                || nodes.find(n => n.login === emailPrefix);
      if (hit) {
        resolvedGithubLogin = hit.login;
        console.log(`[login] resolved GitHub login: ${resolvedGithubLogin}`);
      } else {
        console.warn(`[login] could not resolve GitHub login via GraphQL for "${emailPrefix}". Falling back to "${expectedGithubLogin}".`);
      }
    } catch (e) {
      console.warn(`[login] GraphQL lookup failed: ${e.message}`);
    }
  }

  // 3c. Add to enterprise team (auto-grants Copilot Enterprise seat via the
  //     team's "all orgs" policy + carizon-dev's Selected-members allowlist
  //     including the team). This is the canonical EMU onboarding step —
  //     org membership and Copilot seat both fall out of team membership.
  //     Skipped if no team id configured.
  let teamMembership = null;
  if (enterpriseTeamId && resolvedGithubLogin && githubPat) {
    try {
      const r = await fetch(
        `https://api.github.com/enterprises/${encodeURIComponent(enterpriseSlug)}/teams/${enterpriseTeamId}/memberships/${encodeURIComponent(resolvedGithubLogin)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${githubPat}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'ghe-create-emu-user.cjs',
          },
          body: '{}',
        }
      );
      const text = await r.text();
      if (r.ok) {
        teamMembership = { added: true, teamId: Number(enterpriseTeamId), login: resolvedGithubLogin };
        console.log(`[team]  ✓ added ${resolvedGithubLogin} to enterprise team ${enterpriseTeamId} (this triggers Enterprise-tier Copilot seat via the org's team allowlist)`);
      } else {
        teamMembership = { added: false, reason: `HTTP ${r.status}: ${text.slice(0, 200)}` };
        console.warn(`[team]  failed to add ${resolvedGithubLogin} to team ${enterpriseTeamId}: ${teamMembership.reason}`);
      }
    } catch (e) {
      teamMembership = { added: false, reason: `network: ${e.message}` };
      console.warn(`[team]  network error adding to team: ${e.message}`);
    }
  } else if (enterpriseTeamId && !resolvedGithubLogin) {
    console.warn(`[team]  GHE_EMU_ENTERPRISE_TEAM_ID is set but we couldn't resolve the GitHub login — skipping team add.`);
  }

  // 4. Optional Copilot Enterprise seat assignment. Now mostly redundant
  //    when GHE_EMU_ENTERPRISE_TEAM_ID is set (team-add already triggered
  //    the seat), but kept as belt-and-suspenders. Only runs if SCIM
  //    confirmed the user landed on GitHub (so we know the login). Skipped
  //    silently if the operator didn't ask for it; falls back to a manual
  //    URL when the admin PAT isn't available.
  let copilotSeat = null;
  if (wantCopilotSeat) {
    if (teamMembership?.added) {
      copilotSeat = {
        assigned: true,
        tier: 'enterprise',
        note: `auto-granted via enterprise team ${enterpriseTeamId} (no explicit /selected_users call needed)`,
        viaTeam: true,
      };
      console.log(`[copilot] ✓ Copilot Enterprise seat auto-granted via team membership; skipping explicit /selected_users call`);
    } else {
      const githubLogin = resolvedGithubLogin || scimUser?.userName || expectedGithubLogin;
      if (!scimUser) {
        console.warn(`[copilot] SCIM hadn't returned a user yet; assigning seat to best-guess login "${githubLogin}". Re-run with --wait-scim if it fails.`);
      }
      copilotSeat = await assignCopilotEnterpriseSeat(githubLogin);
      if (copilotSeat.assigned) {
        console.log(`[copilot] ✓ Copilot seat assigned to ${githubLogin} (tier=${copilotSeat.tier || 'unknown'})` + (copilotSeat.note ? ` (${copilotSeat.note})` : ''));
      } else {
        console.warn(`[copilot] seat NOT assigned: ${copilotSeat.reason}`);
        console.warn(`[copilot] manual: ${copilotSeat.manualUrl}`);
      }
    }
  }

  // ─── output ──────────────────────────────────────────────────────────

  const result = {
    ok: true,
    entra: {
      tenantId: process.env.GHE_EMU_TENANT_ID || null,
      userId: user.id,
      userPrincipalName: user.userPrincipalName,
      displayName: user.displayName,
      mailNickname: user.mailNickname,
      forceChangePasswordOnFirstSignIn: true,
    },
    appRole: { name: role, id: APP_ROLES[role], spObjectId },
    enterprise: {
      slug: enterpriseSlug,
      expectedGithubLogin,
      resolvedGithubLogin,
      teamMembership,
    },
    authMethodPreReg,
    initialPassword: password, // print once; nowhere is this kept
    nextSteps: [
      `1. Have the user sign in once at https://login.microsoftonline.com with ${user.userPrincipalName} (they will be forced to change the password).`,
      `2. Wait for SCIM provisioning to push them to GitHub (auto, ≤40min) or trigger on-demand provisioning in Entra.`,
      `3. Their GitHub login is ${resolvedGithubLogin || expectedGithubLogin}${resolvedGithubLogin ? ' (resolved via GraphQL)' : ` (best guess — confirm via GraphQL members(query:"${emailPrefix}"))`}.`,
      copilotSeat?.assigned
        ? `4. Copilot Enterprise seat ALREADY assigned ✓ — proceed straight to ghe-mint-oauth.cjs --account ${resolvedGithubLogin || expectedGithubLogin}.`
        : (wantCopilotSeat
          ? `4. Copilot seat assignment FAILED (${copilotSeat?.reason || 'unknown'}). Manual: ${copilotSeat?.manualUrl || `https://github.com/enterprises/${enterpriseSlug}/copilot/seats`}. Then run ghe-mint-oauth.cjs --account ${resolvedGithubLogin || expectedGithubLogin}.`
          : `4. Assign a Copilot Enterprise seat — either re-run with --copilot-seat (after exporting GHE_COPILOT_ADMIN_PAT) or use the UI at https://github.com/enterprises/${enterpriseSlug}/copilot/seats. Then ghe-mint-oauth.cjs --account ${resolvedGithubLogin || expectedGithubLogin}.`),
      `5. Run ghe-mint-oauth.cjs --account ${resolvedGithubLogin || expectedGithubLogin} to capture a long-lived Copilot OAuth token (browser device-flow; no automation possible — Authorize click is mandatory).`,
      `6. Add their entry to tokens.json under the copilot pool (oauthTokenFile: "~/.ghe/${resolvedGithubLogin || expectedGithubLogin}.oauth"), then POST /quota/reload on the proxy.`,
    ],
  };
  if (copilotSeat) result.copilotSeat = copilotSeat;

  if (scimUser) {
    result.scim = {
      id: scimUser.id,
      userName: scimUser.userName,
      displayName: scimUser.displayName,
      externalId: scimUser.externalId,
    };
    // GitHub assigns the actual login server-side. Surface it if SCIM
    // already told us — overrides our best-effort guess.
    const meta = scimUser?.meta || {};
    if (meta.location) result.scim.location = meta.location;
  }

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    console.log(`✓ Created EMU pool candidate ${user.userPrincipalName}`);
    console.log(`  → role: ${role}`);
    console.log(`  → expected GitHub login: ${expectedGithubLogin}`);
    console.log(`  → initial password (one-time): ${password}`);
    console.log(`  → tell the user to log in at https://login.microsoftonline.com once to change it.`);
    if (copilotSeat?.assigned) {
      console.log(`  → Copilot Enterprise seat: ASSIGNED ✓`);
    } else if (wantCopilotSeat) {
      console.log(`  → Copilot Enterprise seat: NOT ASSIGNED — ${copilotSeat?.reason || 'unknown'}`);
      console.log(`     manual: ${copilotSeat?.manualUrl || `https://github.com/enterprises/${enterpriseSlug}/copilot/seats`}`);
    }
    console.log(`  → next: wait for SCIM (≤40min) then run`);
    console.log(`         ghe-mint-oauth.cjs --account ${resolvedGithubLogin || expectedGithubLogin}`);
  }
})().catch((e) => {
  console.error('[ghe-create-emu-user] error:', e.message);
  if (e.body && process.env.GHE_DEBUG) console.error(e.body);
  process.exit(1);
});

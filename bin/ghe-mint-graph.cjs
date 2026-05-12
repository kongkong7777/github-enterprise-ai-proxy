#!/usr/bin/env node
// ghe-mint-graph — drive a Microsoft device-flow against the Microsoft
// Graph public client (`14d82eec-204b-4c2f-b7e8-296a70dab67e`, the same
// well-known id Microsoft Graph PowerShell uses) and persist the
// resulting access_token + refresh_token into ~/.ghe/graph-token.json.
//
// Why a separate script and not just baked into ghe-create-emu-user?
//   * Device flow needs a human at a browser. Once. The refresh token
//     it returns is good for ~90 days; the rest of our automation reads
//     the access_token from this cached file and silently refreshes it
//     when it expires. Decoupling means cron-driven jobs never block on
//     "please open a browser" prompts.
//   * The token has tenant-wide write scopes
//     (Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All,
//     Directory.ReadWrite.All). Storing it warrants its own audit trail
//     and chmod 600.
//
// What you'll be asked for in the browser:
//   * The 9-character user_code printed below.
//   * Sign in as a tenant member with at least Application Administrator
//     or Cloud Application Administrator rights — those are the roles
//     that can create users + assign app roles on a service principal.
//
// Usage:
//   ghe-mint-graph.cjs                                # interactive mint
//   ghe-mint-graph.cjs --tenant <tenant-id>           # specify tenant
//   ghe-mint-graph.cjs --refresh                      # silently refresh
//                                                     # the access_token
//                                                     # using the saved
//                                                     # refresh_token
//   ghe-mint-graph.cjs --print                        # print just the
//                                                     # access_token to
//                                                     # stdout (for env
//                                                     # piping)

'use strict';

const fs    = require('node:fs');
const os    = require('node:os');
const path  = require('node:path');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function flag(name) { return process.argv.includes(name); }

const tenant      = arg('--tenant') || process.env.GHE_EMU_TENANT_ID || 'organizations';
const clientId    = arg('--client-id') || process.env.GHE_GRAPH_CLIENT_ID || '14d82eec-204b-4c2f-b7e8-296a70dab67e';
// Scope list. Add a new scope here if a downstream script needs an
// API call that's not covered. All scopes are admin-consent so the
// signing user must be Global Admin (or have the role that consents
// to each scope) the FIRST time — subsequent token mints in the same
// tenant reuse the consent.
const scope       = arg('--scope') || [
  'https://graph.microsoft.com/Application.ReadWrite.All',
  'https://graph.microsoft.com/AppRoleAssignment.ReadWrite.All',
  'https://graph.microsoft.com/Directory.ReadWrite.All',
  // Added 2026-05-12: needed to pre-register an email/phone method for
  // a freshly-created EMU user so they can clear the SSPR registration
  // interrupt without owning a real phone. Requires the signing user
  // to hold Authentication Administrator (or Global Admin).
  'https://graph.microsoft.com/UserAuthenticationMethod.ReadWrite.All',
  // Added 2026-05-12: lets ghe-onboard-user.cjs / cleanup scripts hard
  // -delete test Entra users instead of leaving stub shells behind.
  // User.ReadWrite.All is broader than necessary (we only DELETE), but
  // there's no narrower scope for user lifecycle.
  'https://graph.microsoft.com/User.ReadWrite.All',
  'offline_access',
].join(' ');
const wantRefresh = flag('--refresh');
const wantPrint   = flag('--print');
const tokenFile   = process.env.GHE_GRAPH_TOKEN_FILE
  || path.join(os.homedir(), '.ghe', 'graph-token.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postForm(url, params) {
  const body = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  }).then(async (res) => {
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, text };
  });
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
}

function loadStored() {
  if (!fs.existsSync(tokenFile)) return null;
  try { return JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch { return null; }
}

function persist(tokenResp, tenantId) {
  ensureDir(tokenFile);
  const obj = {
    tenantId: tenantId || tenant,
    clientId,
    access_token:  tokenResp.access_token,
    token_type:    tokenResp.token_type,
    expires_in:    tokenResp.expires_in,
    expires_at_ms: Date.now() + (tokenResp.expires_in * 1000),
    scope:         tokenResp.scope,
    refresh_token: tokenResp.refresh_token || null,
    obtained_at:   Date.now(),
  };
  // Atomic write
  const tmp = tokenFile + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, tokenFile);
  return obj;
}

(async () => {
  // --refresh path: use stored refresh_token to mint a fresh access_token.
  if (wantRefresh) {
    const stored = loadStored();
    if (!stored?.refresh_token) {
      console.error(`No refresh_token stored at ${tokenFile}. Run without --refresh to do an interactive mint.`);
      process.exit(3);
    }
    const r = await postForm(`https://login.microsoftonline.com/${stored.tenantId || tenant}/oauth2/v2.0/token`, {
      grant_type:    'refresh_token',
      client_id:     clientId,
      refresh_token: stored.refresh_token,
      scope,
    });
    if (r.status !== 200 || !r.json?.access_token) {
      console.error(`refresh failed HTTP ${r.status}: ${r.text.slice(0, 300)}`);
      process.exit(4);
    }
    const saved = persist(r.json, stored.tenantId);
    if (wantPrint) {
      process.stdout.write(saved.access_token);
    } else {
      console.log(`refreshed: expires in ${saved.expires_in}s, file=${tokenFile}`);
    }
    return;
  }

  // Interactive device flow.
  const dev = await postForm(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`, {
    client_id: clientId,
    scope,
  });
  if (dev.status !== 200 || !dev.json?.device_code) {
    console.error(`devicecode failed HTTP ${dev.status}: ${dev.text.slice(0, 300)}`);
    process.exit(3);
  }
  const { device_code, user_code, verification_uri, expires_in, interval } = dev.json;
  console.log('\n========================================');
  console.log('Open in any browser logged into your tenant:');
  console.log(`  ${verification_uri}`);
  console.log('Enter this code when prompted:');
  console.log(`  ${user_code}`);
  console.log(`Waiting up to ${expires_in}s (poll every ${interval}s)…`);
  console.log('========================================\n');

  const deadline = Date.now() + (expires_in * 1000);
  let pollMs = (interval || 5) * 1000;
  let saved = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const r = await postForm(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
      client_id:   clientId,
      device_code,
    });
    const j = r.json || {};
    if (j.access_token) {
      // Server picks the actual tenant when we said "organizations" — get
      // it back from the JWT for storage.
      let actualTenant = tenant;
      try {
        const payload = JSON.parse(Buffer.from(j.access_token.split('.')[1], 'base64').toString('utf8'));
        if (payload?.tid) actualTenant = payload.tid;
      } catch {}
      saved = persist(j, actualTenant);
      break;
    }
    if (j.error === 'authorization_pending') { process.stdout.write('.'); continue; }
    if (j.error === 'slow_down') { pollMs += 5000; continue; }
    if (j.error === 'expired_token' || j.error === 'access_denied') {
      console.error(`\n${j.error}: ${j.error_description || ''}`);
      process.exit(4);
    }
    console.warn(`\nunexpected: ${r.text.slice(0, 200)}`);
  }
  if (!saved) { console.error('\ndevice flow timed out'); process.exit(5); }

  console.log(`\nstored token at ${tokenFile} (tenant=${saved.tenantId}, expires in ${saved.expires_in}s).`);
  if (wantPrint) {
    console.log('\naccess_token:');
    console.log(saved.access_token);
  }
})().catch((e) => { console.error('error:', e.message); process.exit(1); });

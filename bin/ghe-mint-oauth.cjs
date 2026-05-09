#!/usr/bin/env node
// ghe-mint-oauth — drive a GitHub device flow against the well-known
// Copilot Plugin OAuth client_id and persist the resulting long-lived
// OAuth token into ~/.ghe/<accountId>.oauth.
//
// This is the per-user step that has to happen ONCE for each pool member
// after they're invited + accepted + seated. It cannot be fully
// automated because GitHub's Authorize page (a) requires the invitee to
// be logged into github.com in the same browser session and (b) gates
// the Authorize button behind a deliberate human click — both of those
// are by-design.
//
// What it does:
//   1. POST /login/device/code   → device_code + user_code (e.g. AB12-CD34)
//   2. Print the user_code + URL → user opens URL, types code, clicks Authorize
//   3. POST /login/oauth/access_token → ghu_… long-lived token
//   4. Sanity-call /copilot_internal/v2/token to confirm the token has
//      Copilot scope (sku, expires_at, endpoints).
//   5. Write to ~/.ghe/<accountId>.oauth (chmod 600).
//   6. Optionally hot-reload the proxy via POST /quota/reload.
//
// Usage:
//   ghe-mint-oauth.cjs --account alice
//   ghe-mint-oauth.cjs --account alice --no-reload
//   ghe-mint-oauth.cjs --account alice --client-id Iv1.b507a08c87ecfe98 --reload-url http://127.0.0.1:18081/quota/reload

const https = require('node:https');
const fs    = require('node:fs');
const path  = require('node:path');
const os    = require('node:os');

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(name); }

const accountId = arg('--account');
const clientId  = arg('--client-id') || process.env.GHE_COPILOT_CLIENT_ID || 'Iv1.b507a08c87ecfe98'; // VS Code Copilot Plugin
const noReload  = flag('--no-reload');
const reloadUrl = arg('--reload-url') || process.env.GHE_RELOAD_URL || 'http://127.0.0.1:18081/quota/reload';
const outDir    = process.env.GHE_OAUTH_DIR || path.join(os.homedir(), '.ghe');

if (!accountId) {
  console.error('Usage: ghe-mint-oauth.cjs --account <id> [--client-id <oauth-app-id>] [--no-reload]');
  process.exit(2);
}

function postForm(host, urlPath, params, headers = {}) {
  const body = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'ghe-mint-oauth.cjs',
        ...headers,
      },
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
function getJson(host, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: urlPath, method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'ghe-mint-oauth.cjs', ...headers },
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. Request device code.
  const start = await postForm('github.com', '/login/device/code', { client_id: clientId, scope: 'read:user' });
  if (start.status !== 200 || !start.json?.device_code) {
    console.error(`[device] failed HTTP ${start.status}: ${start.text.slice(0, 200)}`);
    process.exit(3);
  }
  const { device_code, user_code, verification_uri, interval, expires_in } = start.json;
  console.log(`\n========================================`);
  console.log(`Open this URL in any browser logged into GitHub as <${accountId}>:`);
  console.log(`  ${verification_uri}`);
  console.log(`Enter this code when prompted:`);
  console.log(`  ${user_code}`);
  console.log(`Waiting up to ${expires_in}s for authorization (polling every ${interval}s)…`);
  console.log(`========================================\n`);

  // 2. Poll for token.
  const deadline = Date.now() + (expires_in * 1000);
  let pollMs = (interval || 5) * 1000;
  let token = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const r = await postForm('github.com', '/login/oauth/access_token', {
      client_id: clientId,
      device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const j = r.json || {};
    if (j.access_token) { token = j.access_token; break; }
    if (j.error === 'authorization_pending') {
      process.stdout.write('.');
      continue;
    }
    if (j.error === 'slow_down') {
      pollMs += 5000;
      continue;
    }
    if (j.error === 'expired_token' || j.error === 'access_denied') {
      console.error(`\n[device] ${j.error}: ${j.error_description || ''}`);
      process.exit(4);
    }
    console.warn(`\n[device] unexpected: ${r.text.slice(0, 200)}`);
  }
  if (!token) {
    console.error('\n[device] timed out');
    process.exit(5);
  }
  console.log(`\n[device] got OAuth token (prefix=${token.slice(0, 8)}…)`);

  // 3. Sanity-check Copilot session.
  const sess = await getJson('api.github.com', '/copilot_internal/v2/token', {
    Authorization: `token ${token}`,
    'Editor-Version': process.env.GHE_COPILOT_EDITOR_VERSION || 'vscode/1.95.0',
  });
  if (sess.status !== 200) {
    console.warn(`[copilot] WARNING: session probe HTTP ${sess.status} — token may not have Copilot access. Body: ${sess.text.slice(0,200)}`);
  } else {
    const { sku, chat_enabled, endpoints, enterprise_list } = sess.json || {};
    console.log(`[copilot] session OK: sku=${sku} chat=${chat_enabled} endpoint=${endpoints?.api} enterprises=[${(enterprise_list||[]).join(',')}]`);
  }

  // 4. Persist.
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const outPath = path.join(outDir, `${accountId}.oauth`);
  fs.writeFileSync(outPath, token, { mode: 0o600 });
  console.log(`[mint] wrote ${outPath}`);

  // 5. Hot-reload proxy.
  if (noReload) {
    console.log('[mint] --no-reload; not poking the proxy. Restart it or POST /quota/reload manually.');
    return;
  }
  try {
    const u = new URL(reloadUrl);
    const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
    await new Promise((resolve, reject) => {
      const req = lib.request({
        method: 'POST', hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          if (res.statusCode === 200) { console.log(`[mint] hot-reloaded via ${reloadUrl}: ${body.trim().slice(0, 200)}`); resolve(); }
          else reject(new Error(`reload HTTP ${res.statusCode}: ${body.slice(0,200)}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('reload timeout')); });
      req.end();
    });
  } catch (e) {
    console.warn(`[mint] reload failed (non-fatal): ${e.message}`);
  }
})().catch((e) => { console.error('[mint] error:', e.message); process.exit(1); });

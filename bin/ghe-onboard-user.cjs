#!/usr/bin/env node
// ghe-onboard-user — end-to-end orchestrator for adding one new EMU pool
// member to carizon-gh (or any other EMU enterprise). Chains the four
// scripts that used to be run by hand, with a single human pause for the
// browser-based OAuth Authorize click.
//
//   [A] ghe-create-emu-user.cjs --copilot-seat --wait-scim
//        → Creates the Entra ID user, assigns GitHub EMU OIDC app role,
//          waits for SCIM to push them to GitHub, then assigns a Copilot
//          Enterprise seat (requires GHE_COPILOT_ADMIN_PAT).
//
//   [B] PAUSE — print the M365 first-sign-in URL + initial password.
//        Operator hands these off to the new EMU user, who:
//          1. opens https://login.microsoftonline.com
//          2. signs in with <upn> + <initialPassword>
//          3. completes the forced password change
//        This step CANNOT be automated — Entra requires a human to
//        accept the first-sign-in flow. Press Enter when the EMU user
//        confirms they can sign in.
//
//   [C] ghe-mint-oauth.cjs --account <github-login> --add-to-pool
//        → Drives the GitHub OAuth device flow. The EMU user (now signed
//          into github.com via the carizon-gh OIDC redirect) clicks
//          Authorize. The resulting ghu_… token is persisted to
//          ~/.ghe/<github-login>.oauth and registered in tokens.json's
//          copilot pool. Auto-reloads the proxy via /quota/reload.
//
//   [D] curl /quota.json — print the post-onboarding pool snapshot so
//        the operator sees the new account is live.
//
// Usage:
//   GHE_COPILOT_ADMIN_PAT=$(cat ~/.ghe/admin-pat) \
//   GHE_EMU_ENTERPRISE_SLUG=carizon-gh \
//     node bin/ghe-onboard-user.cjs \
//       --email-prefix dev1 --display-name "Dev 1" --role User
//
// Required env (passed through to ghe-create-emu-user.cjs):
//   GRAPH_TOKEN              or GHE_GRAPH_TOKEN_FILE = ~/.ghe/graph-token.json
//   GHE_EMU_ENTERPRISE_SLUG  default carizon-gh
//   GHE_EMU_SP_OBJECT_ID     EMU OIDC service principal Object Id
//   GHE_COPILOT_ADMIN_PAT    PAT with manage_billing:copilot (for --copilot-seat)
//   GHE_EMU_GITHUB_PAT       PAT with scim:enterprise (for --wait-scim polling)

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function flag(name) { return process.argv.includes(name); }

const emailPrefix  = arg('--email-prefix');
const displayName  = arg('--display-name');
const role         = arg('--role') || 'User';
const domain       = arg('--domain') || null;
const skipSeat     = flag('--no-copilot-seat');
const skipMint     = flag('--skip-mint');
const skipPool     = flag('--no-add-to-pool');
const poolId       = arg('--pool-id') || 'copilot';
const enterprise   = process.env.GHE_EMU_ENTERPRISE_SLUG || 'carizon-gh';

if (!emailPrefix || !displayName) {
  console.error('Usage: ghe-onboard-user.cjs --email-prefix <prefix> --display-name "First Last"');
  console.error('                            [--role User|"Enterprise Owner"|"Billing Manager"]');
  console.error('                            [--domain <upn-domain>]');
  console.error('                            [--no-copilot-seat] [--skip-mint] [--no-add-to-pool]');
  console.error('                            [--pool-id <pool>]');
  console.error('');
  console.error('Required env: GRAPH_TOKEN (or graph-token.json), GHE_COPILOT_ADMIN_PAT, GHE_EMU_GITHUB_PAT');
  process.exit(2);
}

const BIN = __dirname;

// Run a child node script and stream its stdout/stderr to ours, returning
// { stdout, stderr, exitCode, parsedJson? } on completion. Captures the
// last JSON object printed (we use this to pull the EMU user details from
// step A).
function runStep(label, scriptPath, args, env = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n────────── [${label}] node ${path.basename(scriptPath)} ${args.join(' ')} ──────────`);
    const child = spawn('node', [scriptPath, ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (b) => {
      const s = b.toString();
      stdoutBuf += s;
      process.stdout.write(s);
    });
    child.stderr.on('data', (b) => {
      const s = b.toString();
      stderrBuf += s;
      process.stderr.write(s);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      // Try to extract the LAST top-level JSON object from stdout.
      let parsed = null;
      const m = stdoutBuf.match(/\n(\{[\s\S]+?\n\})\s*$/);
      if (m) { try { parsed = JSON.parse(m[1]); } catch {} }
      resolve({ exitCode: code, stdout: stdoutBuf, stderr: stderrBuf, parsedJson: parsed });
    });
  });
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(ans); });
  });
}

(async () => {
  // ─── [A] Create EMU user + assign seat ────────────────────────────
  const createArgs = [
    '--email-prefix', emailPrefix,
    '--display-name', displayName,
    '--role', role,
    '--wait-scim',
    '--json',                  // get parseable output for step C
  ];
  if (domain) createArgs.push('--domain', domain);
  if (!skipSeat) createArgs.push('--copilot-seat');

  const stepA = await runStep('A: create-emu-user',
    path.join(BIN, 'ghe-create-emu-user.cjs'), createArgs);
  if (stepA.exitCode !== 0) {
    console.error(`\n[onboard] step A failed (exit ${stepA.exitCode}). Aborting.`);
    process.exit(10);
  }
  const result = stepA.parsedJson;
  if (!result || !result.ok) {
    console.error('[onboard] step A: could not parse JSON result. Aborting.');
    console.error('         If create-emu-user succeeded, re-run with --skip-mint and the explicit github-login.');
    process.exit(11);
  }

  const upn = result?.entra?.userPrincipalName;
  const initialPassword = result?.initialPassword;
  const githubLogin = result?.scim?.userName || result?.enterprise?.expectedGithubLogin;
  if (!githubLogin) {
    console.error('[onboard] could not determine GitHub login from create-emu-user output');
    process.exit(12);
  }

  if (skipMint) {
    console.log(`\n[onboard] --skip-mint requested. Done after step A.`);
    console.log(`  GitHub login: ${githubLogin}`);
    console.log(`  Initial M365 password (one-time): ${initialPassword}`);
    return;
  }

  // ─── [B] Human pause: M365 first sign-in ──────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  [B] HUMAN STEP — M365 first sign-in (one-time, by the new user)');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`  1. Open https://login.microsoftonline.com in any browser`);
  console.log(`  2. Sign in with:`);
  console.log(`        upn:      ${upn}`);
  console.log(`        password: ${initialPassword}`);
  console.log(`  3. Entra will force a password change on first sign-in.`);
  console.log(`     Pick any strong password — we don't need to know it.`);
  console.log(`  4. Confirm the user is now signed in to https://github.com`);
  console.log(`     (the carizon-gh OIDC redirect will sign them in automatically`);
  console.log(`     once their M365 session is live).`);
  console.log('══════════════════════════════════════════════════════════════════════');
  await prompt('\nPress Enter when the new user is signed in and ready for OAuth device-flow … ');

  // ─── [C] OAuth device-flow + add to pool ──────────────────────────
  const mintArgs = ['--account', githubLogin];
  if (skipPool) mintArgs.push('--no-add-to-pool');
  if (poolId !== 'copilot') mintArgs.push('--pool-id', poolId);

  const stepC = await runStep('C: mint-oauth (device flow)',
    path.join(BIN, 'ghe-mint-oauth.cjs'), mintArgs);
  if (stepC.exitCode !== 0) {
    console.error(`\n[onboard] step C failed (exit ${stepC.exitCode}). Manual completion path:`);
    console.error(`  1. Have the user open the URL printed above and authorize`);
    console.error(`  2. Re-run: node bin/ghe-mint-oauth.cjs --account ${githubLogin}`);
    process.exit(13);
  }

  // ─── [D] Confirm via /quota.json ──────────────────────────────────
  console.log('\n────────── [D] verifying pool membership ──────────');
  const reloadUrl = process.env.GHE_QUOTA_URL || 'http://127.0.0.1:18081/quota.json';
  try {
    const lib = reloadUrl.startsWith('https:') ? require('node:https') : require('node:http');
    const data = await new Promise((res, rej) => {
      lib.get(reloadUrl, (r) => {
        let body = '';
        r.on('data', (c) => body += c);
        r.on('end', () => res(JSON.parse(body)));
      }).on('error', rej);
    });
    const pool = (data.pools || []).find(p => p.id === poolId);
    if (!pool) {
      console.warn(`  pool '${poolId}' not found in /quota.json`);
    } else {
      const me = (pool.accounts || []).find(a => a.id === githubLogin);
      if (!me) {
        console.warn(`  ✗ account ${githubLogin} NOT visible in pool — pool has ${pool.accounts.length} account(s)`);
      } else {
        const q = me.quota || {};
        const snaps = q.quota_snapshots || {};
        const prem = snaps.premium_interactions || {};
        console.log(`  ✓ ${githubLogin} is live in pool '${poolId}'`);
        console.log(`    plan: ${q.copilot_plan || '?'}  |  sku: ${q.access_type_sku || '?'}`);
        if (prem.entitlement) {
          console.log(`    premium_interactions: ${prem.used}/${prem.entitlement} (${((prem.used_pct||0)*100).toFixed(1)}%)`);
        }
        console.log(`    pool total: ${pool.accounts.length} account(s)`);
      }
    }
  } catch (e) {
    console.warn(`  /quota.json probe failed (proxy may not be running): ${e.message}`);
  }

  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(`  ✓ onboarding complete for ${githubLogin}`);
  console.log(`    UPN:    ${upn}`);
  console.log(`    Role:   ${role}`);
  console.log(`    Seat:   ${result?.copilotSeat?.assigned ? 'assigned ✓' : 'NOT assigned (check GHE_COPILOT_ADMIN_PAT)'}`);
  console.log('══════════════════════════════════════════════════════════════════════');
})().catch((e) => {
  console.error('\n[onboard] error:', e.message);
  if (e.stack && process.env.GHE_DEBUG) console.error(e.stack);
  process.exit(1);
});

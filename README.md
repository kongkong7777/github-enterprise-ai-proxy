# github-enterprise-ai-proxy

OpenAI-compatible proxy that fronts a **pool of GitHub Personal Access Tokens** against:

- [GitHub Models](https://models.github.ai) (the OpenAI-compatible inference endpoint — `gpt-4o`, `o1`, `claude-3.5-sonnet`, `deepseek-r1`, `mistral-large`, …)
- [GitHub Copilot API](https://api.githubcopilot.com) (passthrough)
- [GitHub REST](https://api.github.com) (passthrough)

The proxy is the GitHub-side companion to [`jetbrains-enterprise-ai-proxy`](https://github.com/kongkong7777/jetbrains-enterprise-ai-proxy). Same operational model: many cheap accounts, one logical endpoint, automatic routing around exhausted accounts, a Chinese-labeled `/quota` dashboard so an operator can see at a glance which PAT is currently bleeding traffic.

## Why

GitHub Models gives every GitHub account a meaningful free tier of LLM requests — but each PAT has its own per-day rate limit (currently in the low hundreds for the free tier, several thousand for Copilot subscribers). The natural way to scale a small team's usage is to register a few accounts, mint one PAT each, and rotate.

Doing that by hand is tedious. This proxy does it automatically:

- One config file (`tokens.json`) lists all the PATs.
- The proxy picks one PAT per request based on quota, sticks with it until it's burnt, then transparently moves to the next.
- A `/quota` dashboard shows live used / remaining / reset-time for every PAT.
- Hot-reload via `POST /quota/reload` so adding or rotating a PAT takes effect without a service restart.

## Architecture

```
       client (OpenAI SDK / curl)
                 │
                 │ Authorization: Bearer <client_key>
                 ▼
        github-enterprise-ai-proxy   (this repo, port 18081)
                 │
                 │ rewrites Authorization: Bearer <pool_PAT>
                 ▼
   ┌─────────────┴────────────┬──────────────────────┐
   │                          │                      │
models.github.ai     api.githubcopilot.com    api.github.com
(/inference/...)     (/copilot/...)           (/api/...)
```

Routing rules (path → upstream):

| Client path                  | Forwarded to                                  |
|------------------------------|-----------------------------------------------|
| `/v1/chat/completions`       | `models.github.ai/inference/chat/completions` |
| `/v1/embeddings`             | `models.github.ai/inference/embeddings`       |
| `/v1/responses`              | `models.github.ai/inference/responses`        |
| `/inference/...`             | `models.github.ai/inference/...`              |
| `/copilot/...`               | `api.githubcopilot.com/...`                   |
| `/api/...`                   | `api.github.com/...`                          |

## Quick start

```bash
# 1. Clone + install
git clone https://github.com/kongkong7777/github-enterprise-ai-proxy.git
cd github-enterprise-ai-proxy

# 2. Configure your PAT pool
cp tokens.example.json tokens.json
$EDITOR tokens.json   # add your PATs

# 3. (optional) tune env
cp .env.example .env

# 4. Run
node bin/github-enterprise-ai-proxy.js
# → [github-enterprise-ai-proxy] listening on http://127.0.0.1:18081
```

Test:
```bash
curl http://127.0.0.1:18081/v1/chat/completions \
  -H "Authorization: Bearer ghe-proxy-team-keyA" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"Hello!"}]
  }'
```

Open the dashboard:
```
http://127.0.0.1:18081/quota
```

## Configuration: `tokens.json`

```json
{
  "defaultPool": "default",
  "pools": [
    {
      "id": "default",
      "clientKeys": ["ghe-proxy-team-keyA", "ghe-proxy-team-keyB"],
      "accounts": [
        { "id": "alice", "tokenFile": "~/.ghe/alice.token" },
        { "id": "bob",   "token": "ghp_..." }
      ]
    }
  ]
}
```

- **`pools`** — independent groups of PATs with their own quota and client-keys. Useful when several teams share the proxy but should not bleed into each other's quota.
- **`clientKeys`** — what callers must put in `Authorization: Bearer <key>`. The proxy uses this to pick which pool to draw from.
- **`accounts[].token`** vs **`tokenFile`** — either inline the PAT or point at a file (recommended; `~` is expanded). Files should be `chmod 600`.
- **`accounts[].oauthTokenFile`** (Copilot pools) — long-lived `ghu_…` OAuth token from `ghe-mint-oauth.cjs`. Drives both inference (session is minted per request) and the quota probe at `/copilot_internal/user`.
- **`accounts[].usedPctCap`** (optional, range `(0, 1]`) — per-account ceiling on `premium_interactions` usage that overrides the global `GHE_QUOTA_BURNT_THRESHOLD`. e.g. `0.5` means "cap this user at 50% of their monthly premium-requests allowance". Routing filter, proactive-swap trigger, and the dashboard's warn/bad colours all scale to this cap. Mirrors the JBA proxy's `usedPctCap`.
- **`disabled: true`** — skip this account in routing without removing it from the file.
- **`disabledReason`** / **`disabledAt`** / **`lastReEnabledAt`** / **`lastReEnabledReason`** — bookkeeping fields written by the swap / unswap / quota-monitor scripts. Distinguishes "monitor auto-disabled this; auto-recover when premium % drops" from "operator disabled this; leave alone". Preserved across restarts.

## Routing

Default strategy: **`fill_first` DESC**. Among the pool's non-burnt PATs we sort by `used_pct` descending and pick the most-used. The choice is then **pinned** until either (a) the pinned PAT crosses `QUOTA_BURNT_THRESHOLD` (95% by default) and gets filtered out, or (b) it drifts more than `ROUTING_HYSTERESIS` (1pp by default) below the new top candidate.

Why DESC: the most-used PAT today probably is yesterday's PAT too. Finishing it off before opening a fresh one means we don't strand half-spent quota across reset boundaries.

Override:

| Env var                       | Default       | Effect                                               |
|-------------------------------|---------------|------------------------------------------------------|
| `GHE_ROUTING_STRATEGY`        | `fill_first`  | `fill_first` / `round_robin` / `random`              |
| `GHE_FILL_DIRECTION`          | `desc`        | `desc` (most-used first) / `asc` (freshest first)    |
| `GHE_ROUTING_HYSTERESIS`      | `0.01`        | Pin tightness (fraction of total quota)              |
| `GHE_QUOTA_BURNT_THRESHOLD`   | `0.95`        | A PAT above this is filtered out of routing          |
| `GHE_QUOTA_REFRESH_MS`        | `300000` (5m) | How often the proxy sweeps every PAT for quota       |

## Quota check

### `models` pools (`GitHub Models` PATs)

Per-PAT quota comes from `GET /rate_limit`:

```jsonc
{
  "resources": { "core": { "limit": 5000, "used": 412, "remaining": 4588, "reset": 1704067200 } },
  ...
}
```

The proxy also pings `GET /catalog/models` to confirm the PAT has Models scope. 401/403 on `/rate_limit` is treated as a dead PAT.

### `copilot` pools (Copilot Enterprise / Business via OAuth)

Each Copilot account holds a long-lived `ghu_…` OAuth token. The proxy's per-account quota probe is **two parallel calls** on every refresh cycle:

```text
GET /copilot_internal/v2/token   →  session token, sku, chat_enabled,
                                    expires_at, endpoints
GET /copilot_internal/user       →  copilot_plan, organization_login_list,
                                    quota_reset_date_utc,
                                    quota_snapshots: {
                                      premium_interactions: { entitlement,
                                                               remaining,
                                                               percent_remaining,
                                                               overage_count },
                                      chat:        { unlimited, … },
                                      completions: { unlimited, … }
                                    }
```

`premium_interactions` is the bucket the **VSCode Copilot extension's "Included premium requests N% used · Resets MMM DD" UI shows** — same numbers, same source. The proxy promotes that bucket to the top-level `used` / `total` / `remaining` / `used_pct` fields so the JBA-style routing logic compares the right thing. The other two buckets (chat / completions) are unlimited under `copilot_enterprise_seat_multi_quota`; we still track them so the dashboard can render them.

A 429 / 477 from any forwarded request immediately marks that account as burnt in the in-memory cache (no waiting for the next sweep).

## Endpoints

### Forwarding

Anything matching the routing table above is forwarded through.

### Operations

| Method | Path                         | Purpose                                                      |
|--------|------------------------------|--------------------------------------------------------------|
| GET    | `/health`                    | Lightweight: is the proxy alive, what's the pool look like?  |
| GET    | `/quota.json`                | JSON snapshot of every pool / account / quota / enterprise   |
| GET    | `/quota`                     | HTML dashboard (auth-protected if `GHE_QUOTA_AUTH` is set)   |
| POST   | `/quota/refresh`             | Force an immediate sweep of every PAT / OAuth token          |
| POST   | `/quota/reload`              | Re-read `tokens.json` in-process; **no service restart**     |
| POST   | `/quota/swap?id=<id>`        | Manually swap-away an account (calls `ghe-swap-account.cjs`) |
| POST   | `/quota/enable?id=<id>`      | Manually re-enable a disabled account (`ghe-unswap-account.cjs`) |

If `GHE_QUOTA_AUTH=user:pass[,user:pass]` is set, all `/quota*` endpoints require Basic auth.

The HTML dashboard exposes "切换走" / "启用" buttons next to each account that fire those `/quota/swap` and `/quota/enable` endpoints. They use a two-stage **arm-and-confirm** pattern (first click arms the button for 6 s, second click within that window actually fires) so the buttons are also safe to drive over CDP/automation — same pattern the JBA proxy uses.

## CLI tools

```bash
# Print every PAT's current quota from the on-disk cache.
bin/ghe-quota-status

# Disable a PAT, then poke the running proxy to hot-reload.
bin/ghe-swap-account --from alice --reason "got a 429 spike"

# Re-enable a PAT (mirror of swap-account).
bin/ghe-unswap-account --from alice                  # one specific account
bin/ghe-unswap-account --auto                        # quota-driven recovery:
                                                     # flip every account that
                                                     # was auto-disabled by
                                                     # quota-monitor and now
                                                     # has fresh quota

# (Copilot Enterprise via EMU only — see "EMU pool members" below.)
bin/ghe-mint-graph                              # one-time Microsoft Graph device-flow
bin/ghe-create-emu-user --email-prefix dev2 \   # provision next pool member into Entra
                        --display-name "Dev 2" \
                        --role User
bin/ghe-quota-monitor --auto-create \           # cron-friendly: rotate when active
                      --next-name dev2 \        # account is depleted, optionally
                      --next-display "Dev 2"    # creating the next Entra candidate
```

## EMU pool members (Copilot Enterprise via Entra ID)

If your `copilot` pool is fed by an **Enterprise Managed Users** enterprise (federated to Microsoft Entra ID), adding a new pool member is fundamentally different from inviting a free GitHub account: there is no email invite, the user must come through SCIM from Entra, and the GitHub login is server-assigned (`<emailprefix>_<shortcode>`). That whole side is automated by:

```
bin/ghe-mint-graph.cjs          one-time device-flow → ~/.ghe/graph-token.json
bin/ghe-create-emu-user.cjs     POST /users + POST /servicePrincipals/{}/appRoleAssignedTo
                                → Entra user + role assignment, ready for SCIM to
                                  push to GitHub at the next provisioning cycle
bin/ghe-mint-oauth.cjs          (already existed) device-flow against the GitHub
                                Copilot OAuth client, run by the new user once
                                they can sign into Entra in a browser
```

End-to-end flow for adding pool member `dev2`:

```bash
# 1. (operator, once per machine) Mint a Graph token. Asks for a code to
#    paste at https://login.microsoft.com/device. Stored at
#    ~/.ghe/graph-token.json with refresh_token; subsequent runs of
#    ghe-create-emu-user silently refresh.
node bin/ghe-mint-graph.cjs

# 2. (operator) Create the Entra account + assign the EMU OIDC app role.
GHE_EMU_TENANT_ID=65685d3b-3f14-4adb-bb0b-8a9c24c52e72 \
GHE_EMU_SP_OBJECT_ID=1ea7b560-fe1a-4a3f-9f28-45fc39c5bce6 \
GHE_EMU_ENTERPRISE_SLUG=carizon-gh \
node bin/ghe-create-emu-user.cjs \
  --email-prefix dev2 --display-name "Dev 2" --role User

# 3. Wait ≤40min for SCIM, or trigger on-demand provisioning in Entra.
#    Confirm the user appeared in GitHub:
gh api scim/v2/enterprises/carizon-gh/Users -H "Accept: application/scim+json"

# 4. (the new user, in a browser) Mints their long-lived OAuth token via
#    GitHub's Copilot device-flow.
node bin/ghe-mint-oauth.cjs --account dev2_carizon

# 5. (operator) Wire the new account into tokens.json's copilot pool and
#    hot-reload the proxy. The mint script can do this for you with --reload.
```

### Why EMU has its own creation path
- **No email invitations**: `/orgs/{org}/invitations` returns "managed users cannot be invited" on EMU.
- **SCIM is the only on-ramp**: the user has to exist on the Entra side first, with a role assignment to the GitHub EMU OIDC service principal. Without the role, Entra's provisioning rejects the user with `MappingEvaluationFailed` (no app-role-assignments to evaluate) or `InvalidRoleData` (a constant string instead of an array of `{value, primary}` objects).
- **Login suffix is fixed**: every managed user gets `<email-prefix>_<enterprise-shortcode>`. The shortcode is *not* the URL slug; check what the setup user's login looks like (e.g. `kongkong_admin` → shortcode is `kongkong`).
- **OAuth still goes through `Iv1.b507a08c87ecfe98`** (GitHub's well-known Copilot Plugin OAuth client). The user's browser will redirect through Entra OIDC during the Authorize step — this is the only step that *requires* a real browser session.

### Copilot 席位（license）自动分配 — 需要一个高权限 PAT

`ghe-create-emu-user.cjs` 默认只把账号建到 Entra + 通过 SCIM 推到 GitHub，**不**自动给新账号分配 Copilot Enterprise 席位 — 因为席位 API 要 `manage_billing:copilot` scope，而 `ghe-mint-oauth.cjs` 拿到的 `ghu_` OAuth token 拿不到这个 scope（即便用户是 Enterprise Owner 也不行，OAuth App 不暴露 billing scope）。

启用席位自动分配只需要一次性动作：

```bash
# 1. 浏览器打开（必须用一个能登录企业的 GitHub 账号 — 通常就是 kongkong7777）
#    https://github.com/settings/tokens/new?scopes=manage_billing:copilot,read:enterprise,read:org&description=ghe-create-emu-user
#    勾上面三个 scope，create token，复制 ghp_… 字符串。

# 2. 写到 ~/.ghe/admin-pat 或者直接 export
export GHE_COPILOT_ADMIN_PAT=ghp_…

# 3. 之后所有 ghe-create-emu-user 都自动分配席位
GHE_COPILOT_ADMIN_PAT=$(cat ~/.ghe/admin-pat) \
GHE_EMU_ENTERPRISE_SLUG=carizon-gh \
node bin/ghe-create-emu-user.cjs \
  --email-prefix dev3 --display-name "Dev 3" --role User \
  --wait-scim --copilot-seat
```

`--copilot-seat`（或 env `GHE_COPILOT_ASSIGN=1`）会在 SCIM 把用户推到 GitHub 之后，立即调用 `POST /enterprises/{enterprise}/copilot/billing/selected_users` 把席位绑过去。失败会给出 manual UI URL 兜底。

### Copilot 席位用量监控 — `ghe-license-status.cjs`

读取 enterprise-level Copilot billing，回答"我们买了几个席位、用了几个、谁在用"。同样需要 `GHE_COPILOT_ADMIN_PAT`。

```bash
# 文本输出（推荐 cron 用）
GHE_COPILOT_ADMIN_PAT=$(cat ~/.ghe/admin-pat) \
GHE_EMU_ENTERPRISE_SLUG=carizon-gh \
node bin/ghe-license-status.cjs
# enterprise: carizon-gh
# seats:      3/5 used  (2 free, 0 pending, 0 pending cancellation, +0 this cycle)
# mode:       assign_selected
# policy:     public_suggestions=allow, ide_chat=enabled, …

# 详细每个席位最近活动 / editor
GHE_COPILOT_ADMIN_PAT=$(cat ~/.ghe/admin-pat) \
node bin/ghe-license-status.cjs --seats

# 给 Slack/jq 用的 JSON
node bin/ghe-license-status.cjs --json | jq '.seats[] | select(.last_activity_at < "2026-04")'
```

席位信息也会在 proxy 进程启动后自动 5 分钟刷新一次，写到 `/quota.json` 的 `enterprise` 字段，并以一条横幅渲染在 `/quota` HTML dashboard 顶部（类似 "3/5 已用 · 2 可用 · 0 待激活"）。proxy 端只需要 export `GHE_COPILOT_ADMIN_PAT` 进它的 systemd `EnvironmentFile=`。

### Quota monitoring + automatic rotation

`bin/ghe-quota-monitor.cjs` is a cron-friendly watchdog. It reads `tokens.json` and the proxy's quota cache, classifies each enabled account as `healthy` / `pressured` / `depleted`, and:

- **Depleted** (`chat_enabled` went `false`, or the rate-limit cache shows used_pct ≥ 100%) → calls `ghe-swap-account.cjs` against that account, hot-reloads the proxy. The swap script now also stamps `disabledReason: "quota-monitor:<reason>"` and `disabledAt` into `tokens.json` so the recovery path can tell auto-disables from manual ones.
- **Recoverable** (account has `disabled: true` AND `disabledReason` starts with `quota-monitor:` AND its cached quota is now < 50% used) → calls `ghe-unswap-account.cjs --auto` to flip it back. This is what "an account ran out at end-of-month, new month started, quota refreshed, the proxy automatically picks it up again" means in code. Manually-disabled accounts are left alone — their `disabledReason` doesn't match the `quota-monitor:` prefix.
- **All-depleted** (the pool just lost its last healthy account) → emits a `pool.drained` event. With `--auto-create --next-name <prefix> --next-display "<name>"` it also calls `ghe-create-emu-user.cjs` to provision the next Entra candidate so an operator only has to do the human Authorize step.
- **Pressured** (≥ `--threshold`, default 80%) → informational only by default.

Cron suggestion:

```
*/5 * * * * /home/apiadmin/github-enterprise-ai-proxy/bin/ghe-quota-monitor.cjs --auto-create --next-name dev$(date +%s) --next-display "rotation pool member" >> ~/.ghe/monitor.cron.log 2>&1
```

Plug the resulting `pool.drained` / `pool.candidate.created` events into Slack/email by setting `GHE_NOTIFY_CMD` to a shell command that reads JSON from stdin.

## systemd

```bash
sudo cp systemd/github-enterprise-ai-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now github-enterprise-ai-proxy
journalctl -u github-enterprise-ai-proxy -f
```

## Security

- The proxy never logs raw PATs. The dashboard, the quota cache, and the failover log all show a redacted label (`ghp_aBcD...wXyZ (40) #91be`).
- Every `/quota*` endpoint can be Basic-auth protected — see `GHE_QUOTA_AUTH`.
- `tokens.json` should be `chmod 600` and is in `.gitignore`. PAT files referenced by `tokenFile` should be too.
- Front the proxy with nginx + TLS for any non-localhost deployment. The proxy itself binds to `127.0.0.1` by default.

## Roadmap

- **Auto-register** — a watchdog that mints new PATs when the pool dips below a healthy count. The JBA sister project does this end-to-end for JetBrains accounts; the GitHub flow needs CAPTCHA bypass + email verification, which is meaningfully harder. Current recommendation: add new accounts manually, drop their PATs into `~/.ghe/<id>.token`, and the proxy picks them up on the next `POST /quota/reload`.
- **Copilot quota probe** — `/rate_limit` only covers REST. Copilot has its own rate limit (currently no public `/rate_limit` analog). Right now we rely on 429 detection at request time.
- **Per-token billing aggregation** — we know `auth_label` per request, but the dashboard currently shows quota only. A daily "spend by token" view is on the list.

## Inspirations / Adapted from

- [`kongkong7777/jetbrains-enterprise-ai-proxy`](https://github.com/kongkong7777/jetbrains-enterprise-ai-proxy) — sibling proxy for JetBrains AI Enterprise. Same architecture, same dashboard layout, same fill_first hysteresis.
- [`kongkong7777/billing-logger`](https://github.com/kongkong7777/billing-logger) — sits in front of both proxies for SQLite traffic logging + the masked auth-token column.
- [GitHub Models REST docs](https://docs.github.com/en/rest/models/inference?apiVersion=2022-11-28).
- The `ai-gateway` and `litellm` projects for the OpenAI-compatible-routing convention.

## License

MIT.

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
- **`disabled: true`** — skip this account in routing without removing it from the file.

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

Per-PAT quota comes from `GET /rate_limit`:

```jsonc
{
  "resources": { "core": { "limit": 5000, "used": 412, "remaining": 4588, "reset": 1704067200 } },
  ...
}
```

The proxy also pings `GET /catalog/models` to confirm the PAT has Models scope (rendered as `Models ✓` / `✗` in the dashboard). 401/403 on `/rate_limit` is treated as a dead PAT and the account is shown red on the dashboard.

A 429 from any forwarded request **immediately** marks that PAT as burnt in the in-memory cache, so the next request routes around it without waiting for the next 5-min sweep.

## Endpoints

### Forwarding

Anything matching the routing table above is forwarded through.

### Operations

| Method | Path              | Purpose                                                      |
|--------|-------------------|--------------------------------------------------------------|
| GET    | `/health`         | Lightweight: is the proxy alive, what's the pool look like?  |
| GET    | `/quota.json`     | JSON snapshot of every pool / account / quota                |
| GET    | `/quota`          | HTML dashboard (auth-protected if `GHE_QUOTA_AUTH` is set)   |
| POST   | `/quota/refresh`  | Force an immediate sweep of every PAT                        |
| POST   | `/quota/reload`   | Re-read `tokens.json` in-process; **no service restart**     |

If `GHE_QUOTA_AUTH=user:pass[,user:pass]` is set, all `/quota*` endpoints require Basic auth.

## CLI tools

```bash
# Print every PAT's current quota from the on-disk cache.
bin/ghe-quota-status

# Disable a PAT, then poke the running proxy to hot-reload.
bin/ghe-swap-account --from alice --reason "got a 429 spike"
```

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

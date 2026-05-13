# Carizon LLM Gateway · API 接口文档

**Base URL**：`https://llm-api.carizon.work`
**鉴权**：每条请求带一个 client API key（不同的接口走不同的鉴权列表，下面会标）
**计费**：所有调用自动写入 billing-logger，按 API Key + 模型 + OAuth 账号维度聚合，dashboard 看 https://llm-api.carizon.work/billing-dashboard

---

## 协议总览

网关一共暴露 4 套协议接口，全部走同一个域名根：

| 协议 | endpoint | 用什么 SDK 调 | 上游 |
|---|---|---|---|
| **Anthropic Messages API** | `POST /v1/messages` | `anthropic` Python SDK / `@anthropic-ai/sdk` / `claude` CLI / Cursor / Cline / Continue / Codex 的 Claude 模式 | Claude 模型 → GitHub Copilot Enterprise 池（kongkong7777 + kongkong_kongkong + dev2 + dev3 + devtest，共 5000 premium/月）|
| **OpenAI Chat Completions** | `POST /v1/chat/completions` | `openai` Python SDK / 任意 OpenAI 协议客户端 | 按 model 名分发 — Claude 走 GHE 池、GPT 走 ChatGPT subscription 池、Gemini 走 Google AI、DeepSeek 走 DeepSeek API |
| **OpenAI Responses API** | `POST /v1/responses` | OpenAI v1 Responses（GPT-5 系列原生协议，支持 reasoning + tool_use） | 同上 |
| **Embeddings** | `POST /v1/embeddings` | `openai.embeddings.create()` | Azure OpenAI（独立 key 配额，跟上面 chat 池不共享）|

辅助接口：

| endpoint | 用途 |
|---|---|
| `GET /v1/models` | 列出所有路由表里注册的 model 名 |

---

## 鉴权

**单一 key 列表，所有 endpoint 共享**——`cli-proxy-api` 的 `api-keys` 列表（`/home/apiadmin/.cli-proxy-api/config.yaml`）。

```yaml
api-keys:
  - kk-test-93301960db5aaccd9733302a16080ca7
  - carizon-123
  - sk-x50JIruzwITrIkia9
  # ...
```

加新 key 只改一处文件，所有接口（chat / messages / responses / embeddings）立即生效，**不需要重启服务**——embeddings 的鉴权也是读这个 YAML 的 mtime 自动刷新（60 秒 cache TTL）。

Header 二选一：

```
x-api-key: <key>                  # Anthropic 风格
Authorization: Bearer <key>       # OpenAI 风格 / OpenAI SDK 默认
```

不在白名单 → HTTP 401 `{"error":"Invalid API key"}`

> **历史包袱**：`.env` 里 `EMBEDDINGS_CLIENT_API_KEYS` 是老版本独立列表，现在保留作 **额外白名单**（不是替代），可以删；删之前确认所有客户端 key 都已经在 `api-keys:` 里。

---

## 接口详情

### A. Anthropic Messages API

```http
POST /v1/messages
Content-Type: application/json
x-api-key: <key>
anthropic-version: 2023-06-01
```

请求体（核心字段）：

```json
{
  "model": "claude-sonnet-4-5",
  "max_tokens": 4096,
  "messages": [
    { "role": "user", "content": "Explain quantum tunneling in 3 sentences." }
  ],
  "stream": false,
  "system": "You are a physics teacher.",
  "temperature": 0.7,
  "thinking": { "type": "enabled", "budget_tokens": 5000 }
}
```

**model 名**（横线分隔，跟 Anthropic 官方一致 — 注意不是点号）：
`claude-haiku-4-5` · `claude-sonnet-4-0` · `claude-sonnet-4-5` · `claude-sonnet-4-6` · `claude-opus-4-1` · `claude-opus-4-5` · `claude-opus-4-6` · `claude-opus-4-7`

可以带日期版本：`claude-sonnet-4-5-20250929` · `claude-opus-4-5-20251101` 等。

**流式**：`stream: true` → 返回 SSE，事件类型：`message_start` → `content_block_start` → `content_block_delta`（增量正文）× N → `content_block_stop` → `message_delta` → `message_stop`。每个 delta 包一段 token。

**非流式**：返回标准 message 对象：

```json
{
  "id": "msg_01YK8f9QBkV4Nzhc7TzQ5GH1",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5",
  "content": [{ "type": "text", "text": "..." }],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 13,
    "cache_read_input_tokens": 1358,
    "output_tokens": 87
  }
}
```

**注意 opus-4-7 的差异**：thinking 用 `{"type": "adaptive"}` + `output_config.effort` 而不是 `{"type": "enabled", "budget_tokens": …}`。网关有兼容垫片，老客户端发老格式也能跑（自动转换）。

### B. OpenAI Chat Completions

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer <key>
```

请求体：

```json
{
  "model": "gpt-5.4",
  "max_tokens": 4096,
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user",   "content": "Explain RAFT consensus in 3 paragraphs." }
  ],
  "stream": false,
  "temperature": 0.7,
  "reasoning_effort": "medium"
}
```

**model 名**（点号分隔，跟 OpenAI 一致）：
- GPT-5 家族：`gpt-5-mini` · `gpt-5.1` · `gpt-5.2` · `gpt-5.3-codex` · `gpt-5.3-codex-spark` · `gpt-5.4` · `gpt-5.4-mini` · `gpt-5.5`
- Claude（通过 OpenAI 协议路由到 Claude）：`claude-sonnet-4-5` 等横线名也支持
- Gemini：`gemini-2.5-pro` · `gemini-2.5-flash` · `gemini-2.5-flash-lite` · `gemini-3-pro-preview` · `gemini-3-flash-preview` · `gemini-3.1-pro-preview` · `gemini-3.1-flash-lite-preview`
- DeepSeek：`DeepSeek-V4-Flash`
- 图像：`gpt-image-2`（特殊接口）

**流式**：`stream: true` → SSE，每个 chunk 是 `data: { ...chat.completion.chunk... }` 一行，`delta.content` 是这次增量的文本。最后一条是 `data: [DONE]`。

**Gemini 流式特殊行为** ⚠️：Gemini-2.5 系列在 stream 模式下**内部跑 reasoning 之后才一次性 dump 全部答案**（只发 1–2 个 SSE chunk）。这是 Google 上游设计，不是网关 bug。要逐 token 体验请用 Claude 或 GPT-5.x；或者加 `reasoning_effort: "none"`（质量会降）。

非流式响应体：

```json
{
  "id": "resp_xxx",
  "object": "chat.completion",
  "model": "gpt-5.4",
  "choices": [{ "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 15, "completion_tokens": 87, "total_tokens": 102, "prompt_tokens_details": { "cached_tokens": 0 }, "completion_tokens_details": { "reasoning_tokens": 0 } }
}
```

### C. OpenAI Responses API

```http
POST /v1/responses
Content-Type: application/json
Authorization: Bearer <key>
```

请求体（更接近原生 GPT-5 协议）：

```json
{
  "model": "gpt-5.4",
  "input": "Explain RAFT consensus in 3 paragraphs.",
  "max_output_tokens": 4096,
  "stream": false,
  "reasoning": { "effort": "medium" },
  "text": { "format": { "type": "text" } }
}
```

`input` 可以是字符串、消息数组（同 chat completions）、或更复杂的 multi-modal 数组。

**流式**：事件类型更细：`response.created` → `response.in_progress` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta` × N → `response.output_text.done` → `response.completed`。每个 `output_text.delta` 是一段增量 token。

何时用 Responses 而不是 Chat Completions：
- 想用 GPT-5 的 `web_search` / `image_generation` 等 built-in tool
- 想看到 reasoning 阶段的 token 用量
- 服务端持久化的 message id（envelope `msg_*` 而不是 `chatcmpl-*`）

### D. Embeddings

```http
POST /v1/embeddings
Content-Type: application/json
Authorization: Bearer <key>          # 注意是 EMBEDDINGS_CLIENT_API_KEYS 白名单
```

请求体：

```json
{
  "model": "text-embedding-3-large",
  "input": "hello world"
}
```

`input` 可以是 string 或 string 数组（批量）。

**支持 model**（上游 Azure OpenAI）：
- `text-embedding-3-large` → dim 3072
- `text-embedding-3-small` → dim 1536
- `text-embedding-ada-002` → dim 1536（legacy）

响应：

```json
{
  "object": "list",
  "model": "text-embedding-3-large",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.012, -0.034, ..., 3072 floats] }
  ],
  "usage": { "prompt_tokens": 2, "total_tokens": 2 }
}
```

无流式概念。

---

## 客户端示例

### Python · Anthropic SDK

```python
from anthropic import Anthropic
client = Anthropic(api_key="kk-test-...", base_url="https://llm-api.carizon.work")
m = client.messages.create(
    model="claude-sonnet-4-5", max_tokens=1024,
    messages=[{"role":"user","content":"hi"}],
)
print(m.content[0].text)
# 流式
with client.messages.stream(model="claude-sonnet-4-5", max_tokens=1024,
                             messages=[{"role":"user","content":"hi"}]) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### Python · OpenAI SDK

```python
from openai import OpenAI
client = OpenAI(api_key="kk-test-...", base_url="https://llm-api.carizon.work/v1")

# chat
r = client.chat.completions.create(
    model="gpt-5.4",
    messages=[{"role":"user","content":"hi"}],
    stream=True,
)
for chunk in r:
    print(chunk.choices[0].delta.content or "", end="", flush=True)

# responses
r = client.responses.create(model="gpt-5.4", input="hi", stream=False)
print(r.output_text)

# embeddings
e = client.embeddings.create(model="text-embedding-3-large", input="hello")
print(len(e.data[0].embedding))   # 3072
```

### LangChain

```python
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_anthropic import ChatAnthropic

# 走 OpenAI 协议
chat = ChatOpenAI(api_key="kk-test-...", base_url="https://llm-api.carizon.work/v1", model="gpt-5.4")
# 走 Anthropic 协议
claude = ChatAnthropic(api_key="kk-test-...", base_url="https://llm-api.carizon.work", model="claude-sonnet-4-5")
# embeddings
emb = OpenAIEmbeddings(api_key="kk-test-...", base_url="https://llm-api.carizon.work/v1", model="text-embedding-3-large")
```

### Codex / Claude Code / Cursor

把 Cursor 或 Continue 之类客户端的 OpenAI base URL 改成 `https://llm-api.carizon.work/v1`、key 填这个 gateway 的 key，model 选 `gpt-5.4` 或 `claude-sonnet-4-5` 就行。

Claude Code（`claude-cli`）：

```bash
export ANTHROPIC_BASE_URL=https://llm-api.carizon.work
export ANTHROPIC_API_KEY=kk-test-...
claude
```

---

## 速率 / 配额 / 计费

- 每个 client key 没有硬速率限制；按上游池子余额来。
- Claude 流量自动走 GHE Copilot 池，5 个账号 fill_first/desc 策略（用满第一个再切下一个），共 5000 premium interactions/月。
- GPT-5 流量走 ChatGPT subscription 上游池（cliproxyapi 维护）；剩 token 在 `/usage-keeper/` 看。
- Gemini 流量走 Google AI API key 池。
- 计费**按 client key 维度归账**：你在 `/billing-dashboard?range=7d` 输入自己的 key 前缀就能看用了多少钱。
- 模型成本数字读自 `/home/apiadmin/billing-logger/upstream-costs.json`，跟实际订阅一致（不是官方 list price）。

---

## 错误码

| HTTP | 含义 | 怎么修 |
|---|---|---|
| 401 `Invalid API key` | key 不在 `~/.cli-proxy-api/config.yaml` 的 `api-keys` 列表 | 找运维往那个 YAML 加一行就行，所有 endpoint 立刻生效（60s mtime 自动刷新）|
| 500 `unknown provider for model X` | model 名拼写错 / 没注册 | `GET /v1/models` 看可用 model 列表 |
| 429 | 上游限速 | 重试，gateway 会自动切到池子里下一个账号 |
| 4xx 业务错误 | 直接来自上游 | 看 response body 的 `error.message`，跟原厂错误对照 |

---

## 监控

- `/home` — 网关总览
- `/quota` — JBA（JetBrains AI）账号池
- `/ghe/quota` — GitHub Copilot 账号池
- `/billing-dashboard` — 按 API Key / 模型 / 账号看花费
- `/traffic-dashboard` — 每条请求的 req/resp body，按 IP / 模型 / 错误 grep
- `/usage-keeper/` — CLIProxyAPI 原生 token 维度统计
- `/management.html` — CPAMC 管理面板（OAuth / 配额 / Key / 提供商）

---

## 当前已知问题

1. **Gemini-2.5 系列流式输出"假流式"**：1–2 个 SSE chunk 包全部输出。原因：Google 上游 reasoning model 内部跑 thinking 期间不发增量。修不了，是上游设计。客户端想真流式请用 Claude 或 GPT-5.x，或加 `reasoning_effort: "none"`。
2. **老 model 名不通**：`gpt-4o` / `gpt-4o-mini` / `claude-3.5-sonnet` 都不在路由表，全部上 GPT-5.x / Claude-4.x。

（embedding 鉴权已经在 2026-05-14 修了，跟 chat 共享同一个 `api-keys` 列表，不需要单独加白名单。）

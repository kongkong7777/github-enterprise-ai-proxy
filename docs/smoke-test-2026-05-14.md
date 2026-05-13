# 接口冒烟测试结果

测试日期：2026-05-14
测试 key：`kk-test-93301960db5aaccd9733302a16080ca7`
入口：`https://llm-api.carizon.work`

## 协议 × 流式覆盖矩阵

| 协议 | endpoint | 模型 | 非流式 | 流式 | 备注 |
|---|---|---|---|---|---|
| Anthropic Messages | `/v1/messages` | claude-sonnet-4-5 | ✅ Pong (3.5s) | ✅ 8 chunks (2.4s) | 真流式，逐 delta |
| Anthropic Messages | `/v1/messages` | claude-opus-4-7 | ✅ pong (2.3s) | ✅ 8 chunks (2.3s) | 真流式 |
| OpenAI Chat | `/v1/chat/completions` | gpt-5.4 | ✅ pong (2.5s) | ✅ 11 chunks (2.0s) | 真流式，逐 token |
| OpenAI Chat | `/v1/chat/completions` | gemini-2.5-pro | ✅ pong (7.8s) | ⚠️ 2 chunks (43s) | **假流式**——见下 |
| OpenAI Chat | `/v1/chat/completions` | gemini-2.5-flash | ✅ | ⚠️ 2 chunks | **假流式** |
| OpenAI Responses | `/v1/responses` | gpt-5.4 | ✅ (2.0s) | ✅ 9 events (1.5s) | 真流式，`output_text.delta` |
| Embeddings | `/v1/embeddings` | text-embedding-3-large | ✅ dim=3072 | n/a | embedding 无流式概念 |
| Embeddings | `/v1/embeddings` | text-embedding-3-small | ✅ dim=1536 | n/a | |
| Embeddings | `/v1/embeddings` | text-embedding-ada-002 | ✅ dim=1536 | n/a | legacy |

## "有人说有的接口不能流式" — 根因

**Gemini 系列模型在流式模式下表现像非流式**，原因是 Google 上游设计：
- Gemini-2.5-pro / flash / flash-lite 都是 **reasoning model**，启用 thinking 之后内部跑 `reasoning_tokens`（测试中 32–410 个），这期间不发任何 SSE chunk
- thinking 完成之后才把最终答案当成 1 个大 SSE chunk dump 出来 + 1 个 `[DONE]`
- 这是 **Google 上游行为**，不是 carizon-gh 网关问题。同样的请求发到 OpenAI 协议路由到 Claude/GPT 都能逐 token 增量

**用户感知到的"流式不工作"**就是用 OpenAI SDK 调 Gemini 时看到的现象。
**3 个缓解方案**：
1. 客户端要"逐 token 流式"体验时**避免选 Gemini-2.x 系列**，用 Claude 或 GPT-5.x
2. 如果一定要 Gemini，加 `reasoning_effort: "none"` 关掉 thinking，但生成质量会降
3. 等 Google 上游修（Gemini-3-pro-preview 已支持更细颗粒的流式）

## 路由表里有什么模型

```
共 31 个模型
─ Claude 家族 (8)    haiku-4-5 / opus-4-1 / opus-4-5 / opus-4-6 / opus-4-7
                    sonnet-4-0 / sonnet-4-5 / sonnet-4-6
─ Gemini 家族 (7)   2.5-pro / 2.5-flash / 2.5-flash-lite
                    3-pro-preview / 3-flash-preview
                    3.1-pro-preview / 3.1-flash-lite-preview
─ GPT 家族 (8)       5-mini / 5.1 / 5.2 / 5.3-codex / 5.3-codex-spark
                    5.4 / 5.4-mini / 5.5
─ Codex (1)         codex-auto-review
─ 图像 (1)          gpt-image-2
─ DeepSeek (1)      DeepSeek-V4-Flash
─ Embedding (3)     text-embedding-3-large/small/ada-002 (走 /v1/embeddings)
```

不在表里 → 路由层 404 / "unknown provider"。`gpt-4o-mini` / `gpt-4o` / `claude-3.5-sonnet` 这些**旧名字**都不在表里，要用新版号。

## 修过的两件事

1. **Embedding key 鉴权独立**：embedding 走 billing-logger `.env` 里 `EMBEDDINGS_CLIENT_API_KEYS` 这个独立 allowlist，不和 cliproxyapi `api-keys` 共享。把 `kk-test-93301960db5aaccd9733302a16080ca7` 加进去，再 restart billing-logger
2. **`gpt-4o-mini` 不存在**——是 model 名问题不是 bug；告诉客户端用 `gpt-5.4-mini` 或 `gpt-5-mini` 顶替

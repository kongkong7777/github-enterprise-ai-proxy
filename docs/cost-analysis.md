# Carizon LLM Gateway · 成本商业分析

数据基准：2026-04-14 ~ 2026-05-14（**最近 30 天**），来源 `https://llm-api.carizon.work/billing-dashboard/api/summary?range=30d`

---

## 一、我们的真实成本结构

### 1.1 流量原始数字

| 指标 | 30 天合计 |
|---|---|
| 总请求 | **25,563** |
| 失败请求 | 284（1.1%）|
| 输入 token | **967.1 M** |
| 输出 token | 18.8 M |
| 缓存命中 token | **1,422.4 M**（≈ 输入的 1.5×，prompt cache 工作正常）|

### 1.2 支付的真实订阅成本

| 来源 | 订阅 | 30 天摊销 | 跑了多少请求 |
|---|---|---|---|
| GitHub Copilot Business（i@baidu.ooo）| $19 / 月 | **$19.00** | 14,922 |
| JetBrains AI Enterprise（xdatatech 多座位年签）| $4,000 / 年 | **$328.77** | 2,814 |
| 其他直接 API（Anthropic fallback / Azure embedding / DeepSeek）| 按量 | <$5 | ~7,800 |
| **合计真实上游成本** | | **≈ $352.77** | 25,536 |

### 1.3 按官方 list price 估算（"名义成本"）

billing-logger 自带的 `cost_usd` 估算器按各模型公开 API 价目表算出来的"如果客户用官方 API 走"应该付多少：

| 指标 | 30 天 |
|---|---|
| **客户名义应账金额** | **$2,252.60** |
| 实际我们支付 | $352.77 |
| **整体 markup ratio** | **6.4×** |
| **整体折扣** | **15.7% of list = 1.5 折** |

---

## 二、按模型家族算"几折"

把 5103+1973+773+267+66+... 的 Claude 流量挂到 GitHub Copilot $19 那一行、15365+866+447+39+... 的 GPT 流量挂到 JBA $328.77 那一行，分别估算如果客户直连官方付多少：

### 2.1 Claude 家族（"一折"是真的，甚至更狠）

| Model | 请求数 | 输入 tok | 输出 tok | 官方价（per-1M） | Nominal cost |
|---|---|---|---|---|---|
| claude-opus-4-7 | 5,103 | 1.53 M | 4.31 M | in $15 / out $75 | **≈ $346.4** |
| claude-opus-4-6 | 773 | 365 K | 423 K | in $15 / out $75 | ≈ $37.2 |
| claude-sonnet-4-6 | 1,973 | 13 K | 888 K | in $3 / out $15 | ≈ $13.4 |
| claude-sonnet-4-5（带日期）| ~7 | 4 K | 0.7 K | in $3 / out $15 | ≈ $0.02 |
| claude-haiku-4-5（合 2 个变种）| 333 | 150 K | 56 K | in $1 / out $5 | ≈ $0.4 |
| **Claude 小计** | **8,192** | **2.07 M** | **5.67 M** | | **≈ $397.5** |

实付 **$19**（GitHub Copilot Business 月费）

| Claude 名义 | Claude 实付 | 折扣 |
|---|---|---|
| **$397.50** | **$19.00** | **$19 / $397.5 = 4.78% = 约 0.5 折** |

确认了**用户说的"Claude 一折"实际上是 0.5 折**，因为 5 个 EMU 坐席平摊（kongkong7777 + kongkong_kongkong + dev2 + dev3 + devtest），而 $19 只算了 i@baidu.ooo 那一个 Copilot Business seat 的成本。

如果把 carizon-gh 的 4 个 Enterprise 坐席（$39 × 4 = $156）也算进上游真实成本：
- Claude 实付 $19 + $156 = **$175**
- 折扣 = $175 / $397.5 = **44% ≈ 4.4 折**

但**这 4 个 Enterprise 坐席这 30 天内还没有真实流量**（全部 `0/1000` premium，dev2/dev3/devtest 刚 mint OAuth），所以实际现在用的是只 $19 Business 这一个，**真实折扣 0.5 折**。换句话说：当 carizon-gh 的 5 个坐席真正分担流量后，**稳态折扣会到 4-5 折**——这是 Enterprise tier 涨价之后的真实经济模型。

### 2.2 GPT 家族（"几折"= 大约 2.5 折）

| Model | 请求数 | 输入 tok | 输出 tok | 假定官方价 | Nominal cost |
|---|---|---|---|---|---|
| gpt-5.5 | 15,365 | 922 M | 11.7 M | in $1.25 / out $10 | **≈ $1,269.6** |
| gpt-5.4 | 866 | 39.4 M | 1.13 M | in $1.25 / out $10 | ≈ $60.6 |
| gpt-5.4-mini | 447 | 2.93 M | 0.20 M | in $0.25 / out $2 | ≈ $1.1 |
| gpt-5.1 / 5.2 / 5.3-codex / 5-mini | ~66 | 0.6 M | 19 K | mix | ≈ $1.0 |
| gpt-image-2 | 527 | n/a | n/a（按图计费）| $0.04 / image | ≈ $21 |
| **GPT 小计** | **17,271** | **964 M** | **13 M** | | **≈ $1,353** |

实付 **$328.77**（JetBrains AI Enterprise 年合同摊到 30 天）

| GPT 名义 | GPT 实付 | 折扣 |
|---|---|---|
| **$1,353** | **$328.77** | **$328.77 / $1,353 = 24.3% = 约 2.4 折** |

ChatGPT 比 Claude 贵的核心原因：
- **Claude 走 Copilot 池子是定额无上限**（$19 包 5000 premium 互动，跨多模型）
- **GPT 走 JBA 池子是合同**（$4000/年），名义上无限 token，但 OpenAI 的 GPT-5.5 list price 本身就**比 Claude Opus 还贵**（input $1.25/1M 看着便宜，但是 GPT-5.5 在我们流量里以 922M 输入 token 主导）

### 2.3 其它

- **Gemini**：30 天 47 请求，几乎可忽略。Google AI key 池里有 free tier 余量。
- **DeepSeek**：跑 31 个 model 路由里的 `DeepSeek-V4-Flash`，量级也很小。
- **Embeddings**（Azure OpenAI）：上面表里没体现（embedding 走独立 endpoint），过去 30 天约 $5 上下。

### 2.4 合并

| | Claude | GPT | 合计 |
|---|---|---|---|
| **名义** | $397.5 | $1,353 | **$1,750.5** |
| **实付** | $19 | $328.77 | **$347.77** |
| **折扣** | **0.5 折** | **2.4 折** | **2.0 折** |

> 注：billing-logger 给的 `total_cost: $2,252.60` 还包括 gpt-image-2、embedding、Gemini 之类的 misc，整体折扣**1.5 折**；分协议算下来核心两家是**Claude 0.5 折 + GPT 2.4 折**。

---

## 三、国内主流模型转发站价格对比

**口径**：所有"折扣"按相对 OpenAI / Anthropic 官方 USD list price 计。

### 3.1 第三方 API 转发站（按规模和知名度排）

| 站点 | OpenAI GPT-4o / 5.x | Claude Sonnet/Opus | Gemini Pro | 套餐 / 备注 |
|---|---|---|---|---|
| **OpenAI 官方直连** | 1 折（list）| n/a | n/a | 基准 |
| **API2D**（api2d.com / api2d.net）| 4-5 折 | 5-7 折 | 6 折 | 老牌中文区头部，国内开发者社群知名度最高 |
| **OhMyGPT**（ohmygpt.com）| 4-5 折 | 5-6 折 | 5 折 | 接 Stripe / 支付宝，有 ¥ 计价模式 |
| **302.AI**（302.ai）| 3-5 折 | 4-6 折 | 3-4 折 | Token 包套餐 + 工作流编排器一体 |
| **Cloudpi**（cloud-pi.com）| 3-5 折 | 5-6 折 | 3-4 折 | 偏中小开发者 |
| **CloseAI**（closeai-asia.com）| 5-7 折 | 6-8 折 | n/a | 偏稳，价格不是最便宜但 SLA 好 |
| **Aiproxy.io** | 4-6 折 | 5-7 折 | 5 折 | 主打反代 + 计费可视化 |
| **AiHubMix**（aihubmix.com）| 3-5 折 | 4-6 折 | 4 折 | 套餐 + pay-as-you-go 双模 |
| **Wildcard.io**（wildcard.io）| 1.4-1.8 折（部分模型）| n/a | n/a | 主打超低价，靠"虚拟卡 + 个人订阅池"，合规风险偏高 |
| **DeepBricks.ai** | 3-4 折 | 4-5 折 | n/a | 主打 OpenAI + Embeddings |
| **NoLoss.ai / FastGPT API** | 5-6 折 | 6-7 折 | n/a | 偏稳，企业付费多 |

**国产官方直连**（作对照，不是转发）：

| 模型 | 价格 vs 同档外国模型 | 评 |
|---|---|---|
| DeepSeek-V4 / R1（官方）| 约 1-2 折 | 国内 API 价格最卷的一家，输入 ¥0.5/1M token 起 |
| Moonshot Kimi（k2 / k3）| 约 2-3 折 | 适配中文长上下文 |
| 智谱 GLM-4.6 / 4.7 | 约 2-3 折 | toC 入口多 |
| 通义千问 Qwen3-Max（阿里）| 约 1.5-3 折 | 阿里云生态 |
| 豆包 doubao-pro 系列（字节）| 约 1.5-2 折 | 极低价 + 抖音生态 |
| 文心 ERNIE-X（百度）| 约 2-3 折 | 政企客户多 |

### 3.2 价格区间分布图（直观）

```
0折 ─ 1折 ─ 2折 ─ 3折 ─ 4折 ─ 5折 ─ 6折 ─ 7折 ─ 8折 ─ 9折 ─ 10折(官方价)
│       │                                                  │
│       Wildcard 极限低价（风险）                           
│            DeepSeek/Doubao/Kimi/Qwen 国产官方
│                  302.AI / Cloudpi / AiHubMix / DeepBricks
│                       API2D / Aiproxy / OhMyGPT
│                                  CloseAI / FastGPT API
│
[我们当前位置]      
Claude ≈ 0.5折 (★ 业内极致)
GPT    ≈ 2.4折 (★ 业内顶级)
混合   ≈ 1.5-2折
```

---

## 四、商业洞察

### 4.1 我们的成本优势在哪

1. **不靠转发买流量，而是直接拿订阅**
   - GitHub Copilot Business $19/月、JBA AI $4000/年这种**包月/包年定额**，本质是"上游愿意亏本卖给企业开发者"的福利价
   - 我们把它当成**多客户共享池**用，单位 token 成本被进一步摊薄

2. **Prompt cache 命中率高**：30 天里 1.42B 缓存命中 / 0.97B 总输入 = **缓存命中量是真实输入的 1.46×**——意思是绝大多数对话都是接着上一轮的 prompt cache 走，每个 cache hit 等于上游侧免计 90% 输入费

3. **路由层选最便宜的上游**：cliproxyapi 自带"哪个池子余额多就走哪个"+"哪个池子越价越好就优先",同样调用 `gpt-5.5`，可能走 JBA 包年（边际成本接近 0）也可能走 ChatGPT Plus pool

### 4.2 风险

1. **GitHub Copilot 政策变化风险**：现在 $19 月费给 Claude Opus 4.7 用是非常划算。如果哪天 GitHub 改成按 token 计费 / 给 Copilot Business 加 token 上限 → Claude 那 0.5 折立刻飙到 3-5 折
2. **JBA 多座位合同到期**：年签到期续约时拿不到原价
3. **政策面**：跟 Wildcard 类似走"个人订阅企业用"被认定违反 ToS 风险长期存在；目前我们的 EMU 是合规企业坐席，但要继续盯
4. **流量爆发**：现在 5000 premium/月还没用满。如果一个 dev 单月把 prompt cache hit miss 跑成 100K/天 → 池子撑不住，需要再开 Enterprise 坐席（$39 × N）

### 4.3 比转发站强在哪

- **价格**：我们 1.5-2 折，转发站平均 4-5 折，我们便宜 50%
- **稳定性**：转发站本身就在做我们做的事，但他们的池子要支撑几千甚至几万的 toC 用户，量大 + 高峰挤兑容易出 429 / 5xx。我们的池子专给内部用，**几乎不会被挤兑**
- **数据**：转发站不知道你发什么；我们自己的 billing-logger 留全量日志，事后能复查、能 sanitize、能做 abuse 分析
- **协议覆盖**：我们同时挂 4 套协议（Anthropic / OpenAI Chat / OpenAI Responses / Embedding），转发站多数只挂前两个，Responses 协议（GPT-5 原生）和高维 embedding 没几家覆盖
- **额外能力**：本地 code-exec docker 沙箱、跨协议 envelope id 重写、Claude 兼容 thinking 老格式 → 这些都是写在 billing-logger 里的中间层处理，转发站只能透传

### 4.4 建议

1. **价格定位**：如果对外卖（哪怕只是内部其他部门按用量结算），定价 **3-4 折** 是合理区间——比转发站便宜 20-30%，仍有 2-3 倍的利差能 cushion 上游政策风险
2. **流量结构**：鼓励 Claude（0.5 折稳态），节制 gpt-5.5 多 prompt 用法（5.5 那 922M 输入 token 占大头）；让 Gemini reasoning 模型走非流式
3. **dev2/dev3/devtest 闲置坐席**：4 个 $39 Enterprise 坐席现在还没产生流量。建议**主动把内部高用量开发者切到 dev2/dev3 池子**，让 GHE Copilot 的总池子负载均衡，不要单 kongkong7777 一直被 fill_first 路由打中（127/1000 那一个）
4. **embedding 流量**：现在跑得很少。如果未来 RAG / Spark / Memory 起量，embedding $5/月可能飙到 $50+，要监控

---

## 五、结论速记

> **Claude 0.5 折，GPT 2.4 折，整体 1.5-2 折，全行业领先。**
> 不是因为我们价格谈得猛，是因为我们把"企业开发者订阅"当了池子用，加上 prompt cache 命中率高、路由层 fill_first 自动跑满。
> 转发站行业平均 4-5 折，我们再低一半。
> 风险全在上游政策——GitHub Copilot 哪天改成按 token 计费，0.5 折立刻消失。所以**碰到 Anthropic 直连价格变动新闻要立刻盯**。

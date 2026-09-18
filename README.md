# dsh-pi-catalog-sync

Sync the pi.dev model catalog into DeepSeek Harness (dsh) llm-pi-ai provider routes through the official settings seam — no source patch — including mixed-protocol routes like OpenRouter, where new models land on a companion route while the built-in route stays untouched.

把 **pi.dev 的模型目录**同步进 DSH 的 `llm-pi-ai` 各 provider 路由，经官方 settings 接缝写盘，不补丁 DSH 源码。

## 为什么需要它

DSH Web「模型」页给预置 provider 的模型列表**不是实时拉取的**，而是读打包在 `@earendil-works/pi-ai` 里的静态快照（`dist/providers/data/*.json`，本机为 2026-09-05 生成、366 个 OpenRouter 模型）。`dsh-llm-pi-ai` 的 `discoverModels` 对 catalog 路由直接返回该快照，**不发任何网络请求**，所以快照之后上架的模型永远搜不到。

pi.dev 把自己的目录以 JSON 公开：

| 端点 | 内容 |
| --- | --- |
| `GET https://pi.dev/api/models` | 全部 39 个 provider 的目录（约 640 KB） |
| `GET https://pi.dev/api/models/providers/<route>` | 单个路由（如 openrouter 377 个模型 / 183 KB） |
| `GET https://pi.dev/api/models/providers` | provider id 列表 |

实测（2026-09-18）：pi.dev 的 openrouter 377 个模型，比本机 pi-ai 快照多 **23** 个，正好包含 `stealth/union-alpha`、`deepseek/deepseek-v4.1-flash`、`~openai/gpt-*-latest` 等新上架模型。字段与 DSH 模型 profile 的词汇表对齐（`id / name / api / baseUrl / provider / reasoning / thinkingLevelMap / input / cost / contextWindow / maxTokens / compat`），翻译成本极低。

## 与已有插件的差别

- `@aiwayds/dsh-model-sync`：同样走 pi.dev → settings，功能完整，但它的翻译规则 13 会**丢弃混合协议路由上的新增模型**（"base-less entry on a mixed-protocol route has no addressable api"）。实测跑它的翻译器：openrouter 写入 366、丢弃 23（含 `stealth/union-alpha`）。原因在 DSH 侧：`models` 条目不能带 per-model `api`，而 openrouter 的内置目录跨 `anthropic-messages` + `openai-completions` 两种协议。
- `@goodandready/dsh-model-sync`：走各 provider 自己的 API 同步 + Web 卡片，但只作用于**自建**路由（有 baseURL/api 的 profile），预置 catalog 路由不在其范围。

本插件的差异点：**混合协议路由也能同步**——默认不碰原路由，把新模型放进一条伴生路由（`openrouter-live`，api `openai-completions`）。

## 工作方式

1. 取 pi.dev 全量目录（ETag / 304 复用 + 本地缓存）。
2. 逐路由判定协议族：内置目录只有一个 api → 原地同步；跨多个 api → 混合协议。
3. 翻译成 settings 可写的模型条目：`name / contextWindow / input`、`reasoningEfforts`（由 pi.dev 的 `thinkingLevelMap` 推导）、`compat.{thinkingFormat,supportsReasoningEffort}`（仅 openai-completions）、容量卫生门（非正整数、或 `maxTokens >= contextWindow` 的列表回声一律不写）。
4. 经 `settings.mutate` 写入 `llm-pi-ai.providers.<路由>.models`（带 revision，`SETTINGS_CONFLICT` 自动重试一次）。

混合协议路由的策略（`mixedProtocolStrategy`）：

| 值 | 行为 |
| --- | --- |
| `companion`（默认） | 原路由保持 pi-ai 内置目录不动；新模型写入伴生路由（api/baseURL 由条目自身推导，可显式配置） |
| `route-api` | 在原路由上写 `api: <单一协议>`，所有模型（含新增）都在原路由，代价是原本走 anthropic-messages 的模型改走 openai-completions |
| `skip` | 只报告，不写 |

## 路线图

- ✅ 规划核心（`lib/plan.js`）：对真实 pi.dev 数据跑通（openrouter → 伴生 23 个新模型；zai-coding-cn / minimax-cn → 原地同步）。
- ✅ settings 写入器（`lib/writer.js`）：`settings.mutate` + revision 校验 + `SETTINGS_CONFLICT` 重试一次、只写变化、dry-run、伴生路由首次创建时才补 `api / baseURL / apiKeyEnv`。19 个单元测试通过。
- ⏳ cordis 接线（`pi-catalog-sync` 配置命名空间、定时刷新、`/pi-catalog-sync` 命令）、Web「模型」页卡片、装进 profile 的端到端验证。

### 已知限制

- 若某路由的用户配置里带了**非空** `modelOverrides`，`llm-pi-ai` 会拒绝同时携带 `models` 列表的路由。本插件对这类路由**跳过并明确报告**（不折叠、不清空，零数据丢失）；要同步就得先清掉该键，或后续加一个 fold+unset 的可选模式。

## 开发

```bash
npm test                                                     # 规划核心单元测试
PI_AI_DATA_DIR=<pi-ai>/dist/providers/data npm run dry-run  # 只读 dry-run：对比 pi.dev 与本机内置目录
```

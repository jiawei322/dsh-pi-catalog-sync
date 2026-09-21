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

## 安装

```bash
dsh plugin add <this repo path or package name>
```

会写进 `~/.dsh/profiles/web/package.json` 并安装；插件只在 settings 命名空间里留痕，不生成任何其他状态文件。

## 配置（`~/.dsh/settings.yaml`）

```yaml
pi-catalog-sync:
  # 空 = 自动使用 DSH 已知（llm-pi-ai 命名空间里已解析出来）且 pi.dev 有目录的路由
  managedRoutes: []
  # companion（默认）| route-api | skip
  mixedProtocolStrategy: companion
  # 混合协议路由上的新增模型落到哪条路由；source 是原路由
  companions:
    - source: openrouter
      route: openrouter-live
      api: openai-completions
      baseURL: https://openrouter.ai/api/v1
      apiKeyEnv: OPENROUTER_API_KEY
  keepBuiltinOnly: true
  forceMaxReasoningEffort: false
  dryRun: false
  intervalMinutes: 240
  startupDelaySeconds: 10
  catalogTimeoutMs: 30000
```

| 键 | 说明 |
| --- | --- |
| `managedRoutes` | 要同步的路由；留空则自动发现（只挑 pi.dev 有目录的那些） |
| `mixedProtocolStrategy` | `companion`：原路由不动、新模型进伴生路由；`route-api`：在原路由写 `api: <单一协议>` 并接管全部模型（代价是原本走 anthropic-messages 的模型改走 openai-completions）；`skip`：只报告 |
| `companions` | 伴生路由定义（`source` = 原混合协议路由）。`api / baseURL / apiKeyEnv` 只在伴生路由**还没**配置该键时才写入 |
| `keepBuiltinOnly` | 保留内置目录里 pi.dev 已没有的模型（避免迁移期模型凭空消失） |
| `forceMaxReasoningEffort` | 给所有非空 thinkingFormat 的模型补 `low/high/max` 档位并强制 `supportsReasoningEffort: true`（400 风险自负） |
| `dryRun` | 只算不写 |
| `intervalMinutes` | 周期刷新（分钟，0 = 只在启动后跑一轮） |
| `startupDelaySeconds` | 启动后延迟多少秒跑第一轮（等 llm 适配器就绪） |

## 命令

| 命令 | 说明 |
| --- | --- |
| `/pi-catalog-sync` | 立刻同步一轮并返回报告 |
| `/pi-catalog-sync --dry-run` | 只算不写，返回同样的报告 |

报告长这样：

```
pi.dev catalog: 39 routes, etag W/"1a2b"
managed routes: openrouter, zai-coding-cn
openrouter: mixed-protocol (anthropic-messages, openai-completions) → companion
  pi.dev 377 · builtin 366 · new 23 · dropped 0
    companion openrouter-live (openai-completions, https://openrouter.ai/api/v1)
  openrouter-live: wrote 23 models
zai-coding-cn: single-protocol (openai-completions) → in-place
  pi.dev 10 · builtin 10 · new 0 · dropped 0
  zai-coding-cn: already in sync (10 models)
```

## 工作方式

1. 取 pi.dev 全量目录（ETag / 304 复用 + 内存缓存）。
2. 逐路由判定协议族：内置目录只有一种 api → 原地同步；跨多种 → 混合协议（内置目录读不到时退回 pi.dev 条目自带的 api 集合）。
3. 翻译成 settings 可写的模型条目：`name / contextWindow / input`、`reasoningEfforts`（由 pi.dev 的 `thinkingLevelMap` 推导）、`compat.{thinkingFormat,supportsReasoningEffort}`（仅 openai-completions）、容量卫生门（非正整数、或 `maxTokens >= contextWindow` 的列表回声一律不写）。
4. 经 `settings.mutate('llm-pi-ai', ops, revision)` 写入，只写变化、撞 `SETTINGS_CONFLICT` 重试一次。

## 已知限制

- 若某路由的用户配置里带了**非空** `modelOverrides`，`llm-pi-ai` 会拒绝同时携带 `models` 列表的路由。本插件对这类路由**跳过并明确报告**（不折叠、不清空，零数据丢失）；要同步就得先清掉该键。
- 伴生路由需要自己的凭证：`apiKeyEnv` 指向的环境变量必须和原路由上游一致（OpenRouter 用 `OPENROUTER_API_KEY`）。没配就该路由不写入并报告。
- 只处理 pi.dev 有目录的路由。

## 路线图

- ✅ 规划核心（`lib/plan.js`）、settings 写入器（`lib/writer.js`）、同步引擎（`lib/sync.js`）、cordis 接线与 `/pi-catalog-sync`（`lib/index.js`）；31 个单元/集成测试。
- ⏳ Web「模型」页卡片（在设置页预览 diff + 一键同步）。
- ⏳ `modelOverrides` 的 fold + unset 可选模式。

## 开发

```bash
npm install                                                  # peers（@deepseek-ai/schemastery 等）供测试加载接线层
npm test                                                     # 31 个测试
PI_AI_DATA_DIR=<pi-ai>/dist/providers/data npm run dry-run   # 只读 dry-run：对比 pi.dev 与本机内置目录
```

`test/index.test.mjs` 在 `@deepseek-ai/schemastery` 缺失时会自动 skip（所以 clone 下来不装依赖也能跑其余 25 个测试）。

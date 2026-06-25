## Context

现有 API 翻译统一走 `main/translate/services/api.ts` 的 `handleAPIBatchTranslation`：它把一批字幕映射成 `batchContents: string[]`（每条 = `subtitle.content.join('\n')`），调用 `translator(batchContents, provider, src, tgt)`，并要求**返回等长 `string[]`**，否则报 "count does not match"。它已内置：批次间 `requestInterval` 等待、批级 `maxRetries` 重试、失败批次降级为 `[翻译失败: ...]`。

provider 通过 `types/provider.ts` 的 `PROVIDER_TYPES` 声明；`isAi:false` 走 API 路径；`group:'free'|'ai'|'mt'` 决定 UI 分组。语言码经 `main/helpers/utils.ts` 的 `convertLanguageCode(code, target)` 转换，`target` 受 `TranslateProvider` 联合类型约束。

约束：免费源均为浏览器/消费级逆向接口，无官方额度，主要风险是 IP 软限流（429）与接口随时失效。

## Goals / Non-Goals

**Goals:**

- 新增免 Key 的 `bingFree`、`googleFree` 两个 provider，且能直接单独使用。
- 提供一个聚合 provider `autoFree`，按**可配置有序回退链**自动切源，单源失败/限流不致整批失败。
- 提供**客户端限速器**（最小请求间隔 + 滑动窗口最大请求数），按 provider id 维度生效，降低封禁概率。
- 复用现有 translator 函数签名与 `handleAPIBatchTranslation`，最小侵入。

**Non-Goals:**

- 不接入需要 Key 的服务（已存在）。
- 不在本变更内引入翻译结果持久化缓存（列为后续增强）。
- 不实现 ASR 免费源（必剪/剪映）——本次仅"免费翻译"。

## Decisions

### D1. 沿用现有 translator 契约，免费源即普通 API provider

每个免费源实现为 `async (query: string[], proof, src, tgt) => Promise<string[]>`，注册进 `TRANSLATOR_MAP`，`isAi:false`。好处：批级重试/进度/取消等全部复用，零改动主流程。

- 备选：在 `translateWithProvider` 外层包裹回退 → 否决，会绕过既有批级逻辑且更易出错。

### D2. Bing（Edge 免费）— 匿名 token + 批量

- 取 token：`GET https://edge.microsoft.com/translate/auth`（返回 JWT，约 10 分钟有效）。
- 翻译：`POST https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=<lang>`，body 为 `[{ "Text": t }, ...]`，回 `resp[i].translations[0].text`，**天然等长**，完美匹配 D1 契约。
- token 用**模块级缓存** + 取得时间戳；超过 ~9 分钟或遇 401/403 自动重取一次再重试。
- 语言码：新增 `bing` 映射键（`zh-Hans`/`zh-Hant`/菲律宾语 `fil` 等），其余默认用 `value`。

### D3. Google（免费）— 用 JSON 接口，逐条翻译

- 用 `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=<lang>&dt=t&q=<text>`（返回 JSON，比抓 `/m` 网页稳）。
- 该接口一次一段文本：**逐条**翻译 `query` 数组元素，把 `data[0]` 的多个句段重新拼回单条字符串，保证返回数组与输入**等长**。
- 语言码：复用现有 `google` 映射（`zh-CN`/`zh-TW` 等同样适用于 `translate_a`）。
- 默认设较小 `requestInterval`（如 0.3s）并限并发，降低 429。

### D4. 限速器 `main/translate/utils/rateLimiter.ts`

- 主进程内存级，按 `providerId` 维度持有：最小间隔 `minIntervalMs` + 滑动窗口 `windowMs`/`maxInWindow`。
- 暴露 `await acquire(providerId, cfg)`：必要时 `await` 到允许时刻；窗口满则等待最早记录过期。
- 配置来源：provider 字段 `requestInterval`（已存在，复用）+ 可选新字段 `windowMaxRequests`。免费 translator 在每次真实网络请求前调用 `acquire`。
- 备选：仅靠 `handleAPIBatchTranslation` 的批间隔 → 否决，回退链内的多次尝试和并发任务无法被它覆盖。

### D5. 回退编排 `main/translate/services/fallback.ts` + provider `autoFree`

- `createFallbackTranslator(chain: string[])` 返回一个标准 translator 函数：对给定 batch，按 `chain` 顺序尝试各底层 translator（从 `TRANSLATOR_MAP` 取），每次尝试前过限速器；
- 成功（返回等长且非全失败）即返回；某源抛错或被限流则记录并切下一源；**全部失败才抛错**（交由批级重试/降级处理）。
- `autoFree` provider 的 `proof.fallbackChain` 默认 `['bingFree','googleFree','deeplx']`，UI 可编辑顺序；deeplx 缺端点时该源自动跳过。
- 不把 fallback 写死在某个源里，保持各源可独立选用，聚合仅由 `autoFree` 承担。

### D6. 错误语义

- 免费源**不**因缺少 apiKey 触发 `isConfigurationError`（它们无需 Key）；deeplx 缺 `apiUrl` 视为"该源不可用"在回退中跳过，而非配置错误中断。
- 区分可重试错误（网络/429/5xx/解析空）→ 触发回退/批级重试；与不可恢复错误（明确不支持语言）→ 直接抛出。

## Risks / Trade-offs

- **免费接口改版/失效** → 端点与解析集中在各 service 文件顶部常量，便于热修；多源回退降低单点风险。
- **IP 被限流 (429)** → 限速器（间隔+窗口）+ 用户可调 `requestInterval` + 回退切源。
- **Bing token 过期/失效** → 缓存+到期与 401/403 自动续期重试一次。
- **Google 多行对齐错乱** → 逐条翻译并重新拼接句段，请求前后校验数组等长。
- **合规/ToS** → 文档标注为社区逆向接口、默认可关闭、用户自担；不内置任何凭据。
- **取舍**：免费源放弃"质量稳定性契约"换取"零配置高可用"，以回退+限速+清晰降级把不确定性控制在批级。

## Migration Plan

- 纯增量：新增 2 个源 + 1 个聚合 provider + 限速/回退工具；不改动既有 provider 行为。
- 回滚：从 `TRANSLATOR_MAP` 与 `PROVIDER_TYPES` 移除新条目即可，无数据迁移。

## Open Questions

- `autoFree` 是否要把用户已配置的付费源也纳入回退尾部（如 `... → openai`）？默认仅免费源，留作可选。
- 是否需要把"翻译结果缓存（按 内容+目标语言）"一并做进来以进一步降请求量？倾向作为后续独立变更。

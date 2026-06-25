## Why

目前项目里"传统机翻"全部需要用户申请 API Key（百度/火山/阿里/腾讯/讯飞/小牛），连 `google` 走的也是付费的 Google Cloud Translation API。新用户开箱即用的免费翻译能力是缺失的。参考卡卡字幕（VideoCaptioner），可以借用浏览器/消费级产品中无需 Key 的翻译接口（Bing Edge、Google 网页版），实现"装好即用"的免费翻译。

这些接口没有官方计费额度，但也因此没有"契约保证"：真正的约束是按 IP 的软限流（429）和接口随时可能失效。所以免费翻译必须配套**客户端限速**与**多源失败自动回退**，否则单源被限流就会整任务失败。

## What Changes

- 新增免费、免 Key 的翻译 provider：
  - **Bing（Edge 免费）**：匿名 token + 批量翻译，质量等同 Azure Translator（首选）。
  - **Google（免费网页版）**：`translate_a/single?client=gtx` JSON 接口，单条翻译，作回退。
  - DeepLX 已存在（免 Key、用户自填端点），纳入回退链统一管理。
- 新增**客户端限速**机制：每个免费 provider 可配置最小请求间隔 / 滑动窗口最大请求数，避免触发 IP 封禁。
- 新增**多源失败回退**：可配置有序的免费源回退链（如 `bingFree → googleFree → deeplx`），某源连续失败/被限流时自动切换到下一源，仅当所有源失败才判定该批失败。
- 免费 provider 归入 UI 的 `free` 分组，默认无需任何配置即可使用。

## Capabilities

### New Capabilities

- `free-translation`: 免 Key 的免费翻译源接入（Bing/Google 免费版）、客户端限速、以及多源失败自动回退链。

### Modified Capabilities

<!-- 现有翻译流程为隐式实现、openspec/specs 下暂无既有 spec，故不在此登记“修改型能力”。回退与限速以新能力 free-translation 承载。 -->

## Impact

- **新增代码**：`main/service/bingFree.ts`、`main/service/googleFree.ts`；限速器 `main/translate/utils/rateLimiter.ts`；回退编排 `main/translate/services/fallback.ts`。
- **修改代码**：
  - `main/service/index.ts`（导出新 translator）
  - `main/translate/services/translationProvider.ts`（`TRANSLATOR_MAP` + 回退接入）
  - `types/provider.ts`（`PROVIDER_TYPES` 新增 `group:'free'` 条目、回退链字段）
  - `main/helpers/utils.ts`（`TranslateProvider` 联合类型 + `supportedLanguage` 补 `bing`/`googleFree` 语言码）
  - `renderer/public/locales/{zh,en}/common.json`、`translateControl.json`（名称与提示文案）
- **依赖**：复用现有 `axios`，无需新增三方依赖。
- **行为/兼容**：纯新增 provider 与可选回退，不改变现有付费 provider 行为；非破坏性变更。
- **风险**：免费接口属灰色地带，可能被限流或失效；以限速 + 回退 + 清晰报错降级缓解。

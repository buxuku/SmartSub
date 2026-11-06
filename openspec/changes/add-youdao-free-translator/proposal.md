# Proposal: add-youdao-free-translator

## Why

「自动免费翻译」(`autoFree`) 目前按 必应 → 谷歌 → DeepLX 逐条请求。2026-10 实测必应免费接口单条中位延迟约 1.28 s（单会话 87 条，响应带 `usedLLM:true`），一集 600 条字幕串行约 13 分钟（推算）；谷歌免费接口在部分网络需要代理，DeepLX 需自备端点。零配置用户实际只有必应一个可用来源：翻译成了首次体验里最慢的一步，必应一旦改版（`bingFree` 已经重写过一次协议）又没有第二来源兜底。

有道网页翻译接口（非官方）已做过一次受控压测（2026-10，共 5,537 次请求，含 40 req/s × 30 s 爬坡）：无任何 429/403 与连续失败；换行拼接即可整批翻译，服务端逐段回显原文，可校验对齐（14,400 条 / 288 次请求 / 80 s，0 错位；每集 600 条约 2.4 s，批量 50 条/请求、间隔 0.2 s）。质量略低于必应（101 行单人评审：有道 77 好 / 18 生硬 / 6 错，必应 86 / 14 / 1，差异统计上不显著；无标点的 ASR 风格长句差距更大），且会破坏 HTML 标签、ASS 覆盖标签、♪ 与对白破折号，需要预处理保护。

结论：有道适合作为「免费、很快的草稿级来源」，而不是质量档。主要风险是非官方接口的维护成本（同类开源项目 Easydict 在 2023-05 与 2024-12 各出现一次因接口变化导致的失效，约 2–3 周内修复）。本变更用回退链、会话凭据自愈、响应完整性校验（含「诱饵响应」防护）、快速失效与文档披露控制该风险。

## What Changes

- 新增内置免费翻译源 `youdaoFree`（无需 Key，`group: free`）：既是独立可选服务商，也可加入 `autoFree` 回退链。
- 批量翻译：整批以换行拼接为一次请求（默认 30 条/批、并发 2、最小间隔 0.2 s），用服务端回显的原文校验每条对齐；校验失败时整批降级为逐条请求，仍失败则交给回退链。
- 字幕保护：发送前剥离并记录每行首尾标记（HTML 标签、ASS 覆盖标签、♪、对白破折号、方括号音效），译后逐行还原；不含字母的行原样保留；对中文目标做必要的标点与数字规范化。
- 会话凭据：访客 Cookie（取自站点首页的 `Set-Cookie`，不自造）+ 密钥材料，仅内存缓存、不落盘；建立后用固定探针文本做一次端到端自检；`code` 50、扁平「诱饵」响应、解密失败或空结果视为会话失效，重建一次后重试；连续失败触发有道专用的快速失效（熔断），让回退链立即切到下一个源，避免拖慢整批。实现阶段复核公开网页脚本时发现：签名失效时服务端会返回 `code` 0 的无关译文而不是报错，因此形状校验与探针是必需的（见 design「协议复核」）。
- 语言支持：`supportedLanguage` 新增 `youdao` 列，以实测白名单为准；不支持的语言/方向抛出 `not supported language`，由回退链跳到下一个源。
- `autoFree` 集成：回退链源表与链编辑器加入 `youdaoFree`；默认顺序调整为 `youdaoFree → bingFree → googleFree → deeplx`（已确认采用方案 A，见 design OQ1）；迁移时只更新「未自定义的旧默认链」，保留用户自定义顺序。
- 配置与文案：`types/provider.ts` 新增服务商定义与字段默认值；迁移逻辑把 `youdaoFree` 纳入免费源；zh/en 资源与文档站（内置免费翻译页、选型总览、README 三语）同步，并如实标注「非官方接口，可用性不做保证」。
- 测试：扩展 `test:free-translators`（协议、批量对齐、保护与还原、凭据建立与重建、诱饵拒绝、错误分类、熔断、链集成与迁移）；CI 一律不访问真实网络，另列手动实网冒烟清单。

## Capabilities

### New Capabilities

- `youdao-free-translation`: 有道免费翻译源的会话凭据与完整性自检、批量对齐校验、字幕保护与还原、限速并发默认值、错误分类与快速失效。
- `free-translation-fallback`: 自动免费翻译回退链的源注册、默认顺序、链编辑可选源、不可用/不支持语言的跳过，以及旧默认链的迁移。

### Modified Capabilities

- `docs-provider-guides`: 内置免费翻译页覆盖有道源，并按「稳定性受限服务」要求披露非官方接口风险。

## Impact

- `main/service/youdaoFree.ts`（新）、`main/service/index.ts`
- `main/translate/services/{translationProvider,fallback}.ts`
- `main/helpers/{utils,providerMigration}.ts`
- `types/provider.ts`
- `renderer/components/ProviderForm.tsx`、`renderer/public/locales/{zh,en}/{common,translateControl}.json`
- `scripts/test-youdao-free.cjs`（新，并入 `test:free-translators`）、`scripts/test-provider-fallback.ts`（迁移与链集成）
- `docs/docs/guides/translation/{free,overview}.md`、`docs/docs/features/subtitle-translation.md`、README 三语

不包含：共享或内置任何第三方密钥/账号；反检测、代理轮换等规避手段；对必应、谷歌、DeepLX 源行为的修改（含必应并发默认值）；链级通用熔断；术语表与 AI 助手集成（免费源不支持术语表，保持不变）；复制 Easydict（GPL-3.0）源码（见 design D1 的清洁室约束）。本阶段只起草提案，不修改源码。

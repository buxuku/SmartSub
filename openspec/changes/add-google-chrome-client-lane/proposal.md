# Proposal: add-google-chrome-client-lane

## Why

谷歌免费源（`googleFree`，以及 `autoFree` 链里排第三的谷歌）目前只有一条通道：`translate_a/single?client=gtx`，一条字幕一个请求。这条通道受 Google 按 IP 信誉的软限流影响：上游 Subtitle Edit 记录到它约自 2026-08-21 起间歇返回 429 + 「Sorry…」异常流量页，持续数分钟到数小时（[#14015](https://github.com/SubtitleEdit/subtitleedit/issues/14015)、[PR #14050](https://github.com/SubtitleEdit/subtitleedit/pull/14050)）。本项目开发机出口 IP 上，`client=gtx` 在 2026-10-13、10-14、10-15 三天的每次探测都是 429；而同一 IP、同一主机 `translate.googleapis.com` 上的 `client=dict-chrome-ex`（通称 clients5 通道）在 2026-10-13 的 206 次合法请求全部 HTTP 200，10-14 与 10-15 的金丝雀也是 200。9 种「主机 × 路径 × client」组合的对照表明：限流桶按 `client` 参数划分，与域名、路径无关。

后果有两层。可用性：gtx 被限的网络里，显式选用「谷歌免费翻译」的用户完全不可用，`autoFree` 里它也成了摆设。速度：gtx 通道逐条请求，600 条字幕要 600 次请求，按默认间隔 0.5 s 的下限约 300 s（推算）；`translate_a/t` 通道一个请求可带多个 `q`，实测 600 条、每批 20 条、间隔 0.5 s 共 30 次请求 34.6 s，0 失败。

结论：不新增服务商，而是在 `googleFree` 内部加第二条通道（整批、优先），gtx 作回退，两条通道互为备份、各自冷却。范围与通道顺序已由维护者确认（2026-10-15，方案 B、chrome 优先）。

## What Changes

- `googleFree` 内部拆成两条通道，按固定顺序使用：① chrome 通道（`translate_a/t?client=dict-chrome-ex`，一个请求带多个 `q`，整批翻译）优先；② gtx 通道（现状，逐条）作回退。顺序是内部常量，不对用户开放；服务商 id、字段与默认值（批量 5、并发 1、间隔 0.5 s）不变，无需迁移。
- chrome 通道的整批协议：按「编码后查询串 ≤ 6,000 字节、`q` ≤ 50 个」切块；空白条目不发送、原位还原；按条数校验对齐，两种响应形状（显式 `sl` 的字符串数组；`sl=auto` 的 `[译文, 检测语言]` 数组）都接受；条数或形状异常、任何一项译文为空，视为该通道本块失败，该块改走 gtx 通道；仅因空项被拒绝的块，先在 chrome 通道内用同样的请求重发一次，重发仍被拒绝才改走 gtx。
- 通道健康（进程内存、不落盘、每条通道独立）：被限（429 或 403，且响应体含异常流量页标记）→ 冷却 10 分钟起，连续被限翻倍、上限 60 分钟；其它失败（网络错误、超时、5xx、协议异常）连续 3 次 → 冷却 120 s；冷却结束只放行一个探测请求；成功清零。一条通道对某一块失败时，同一块立即改走另一条通道（每块最多切换一次）。
- 两条通道都不可用时不发任何请求，抛出带 `(network)` 的错误；导出 `getGoogleFreeAvailability()`，`autoFree` 在两条通道都不可用时以 info 级别跳过谷歌（与有道一致），不让每个批次先失败一次。
- 限速与取消：两条通道共用限速键 `googleFree:<providerId>`，每个 HTTP 请求前 `acquire`；沿用同一 `axios`（自动跟随全局代理）与同一 UA；chrome 通道专用 15 s 超时；取消信号贯穿且不计入通道失败。
- 克制与隐私：不轮换 `client` 标识、不轮换代理、不伪装指纹、不绕过异常流量页；日志不记录 URL（GET 的 URL 含字幕原文）、原文、译文与响应体，只记录通道、状态类别与冷却时长。
- 文案与文档：更新 zh/en 的 `batchSizeGoogleFreeTips`、`batchSizeAutoFreeTips`、`fallbackChainTips`，以及免费翻译指南里的谷歌行与「非官方接口、不承诺可用性」披露。
- 测试：新增 `scripts/test-google-free.cjs`（协议、切块、对齐、通道切换、冷却与探测、取消、日志隐私、可用性与回退链集成），并入 `test:free-translators`；CI 一律不访问真实网络，另列手动实网冒烟清单。

## Capabilities

### New Capabilities

- `google-free-translation`: 谷歌免费翻译源的双通道（chrome 整批优先、gtx 逐条回退）、整批协议与对齐校验、通道健康与冷却、限速与取消、可用性自省，以及克制与隐私约束。

### Modified Capabilities

（无。回退链「跳过不可用源」的行为属于 `free-translation-fallback`，该能力目前只存在于尚未归档的 `add-youdao-free-translator` 变更里，`openspec/specs/` 中还没有它。本变更把谷歌的可用性要求写在新能力 `google-free-translation` 里，不对未归档的 delta 产生依赖；`add-youdao-free-translator` 归档后，如需把「按可用性跳过」泛化为链的通用要求，另起变更。）

## Impact

- `main/service/googleFree.ts`（改：通道选择、健康状态、可用性导出）、`main/service/googleFreeProtocol.ts`（新：查询串构造、切块、响应解析、异常页识别，纯函数）
- `main/translate/services/fallback.ts`（`isSourceUnavailable` 增加谷歌可用性判断）
- `renderer/public/locales/{zh,en}/translateControl.json`（三条提示文案）
- `scripts/test-google-free.cjs`（新，并入 `test:free-translators`）、`package.json`
- `docs/docs/guides/translation/free.md`

不包含：新服务商、新字段、迁移（`CURRENT_PROVIDER_VERSION` 保持 26）；修改 `googleFree` 的默认批量与 `autoFree` 的链顺序；轮换 `client` 标识、代理或 UA，指纹伪装；用户可见的通道选择；通道状态持久化；对有道、必应、DeepLX 的任何修改；复制第三方实现代码（协议事实来自本机实测与公开讨论）。本阶段只起草提案，不修改源码。

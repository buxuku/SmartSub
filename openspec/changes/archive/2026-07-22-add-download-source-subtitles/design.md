# Design: add-download-source-subtitles

## Context

本变更是 add-video-downloader 显式预留的后续增量，主线是「下载侧写增量、向导侧零改动」。已验证的现成咬合点：

- **命名天然匹配配对规则**：yt-dlp 字幕落盘为 `%(title)s [%(id)s].<lang>.srt`，视频为 `%(title)s [%(id)s].<ext>`；`renderer/lib/filePairing.ts` 的前缀规则（字幕主干 = 视频主干 + `.`）注释原文即 `foo.zh.srt ↔ foo.mp4`，`[id]` 后缀同时消除同名撞车。
- **向导自动进配对模式**：`inputKind === 'paired'` 由文件形态推导（媒体+字幕混合即成立），配对后任务文件携带 `providedSubtitlePath`，`main/helpers/fileProcessor.ts` 直接以其为源字幕、提取/听写两节点置 done。
- **交接的唯一断点**：`DownloadPanel.sendToTasks` 现用 `taskType:'media'` 包装，字幕会被 `getDroppedFiles` 滤掉；`ipcHandlers.ts` 的 `taskType:'any'` 本就媒体+字幕双收，改参数值即通。
- **预检有现成挂点**：`parsers.ts` 的 `parseYtDlpPreflightJson` 已解析 `-J` 输出，补读 `subtitles` 字段即可；ffmpeg 已通过 `--ffmpeg-location` 注入，`--convert-subs` 零新增依赖。
- **约束**：向导配对模式要求每个视频都有配对字幕，存在未配对视频时阻断开始（`wizard.blockUnpairedMedia`）——部分条目有字幕的批次交接需给用户逃生口（见 D5）。

## Goals / Non-Goals

**Goals:**

- 含官方字幕的视频在预检阶段可见（徽章 + 语言），下载时同取字幕并转 srt，产物登记 `kind:'subtitle'`。
- 一键交接后向导自动配对、跳过 ASR，全程无需用户手动摆文件。
- 保持增量最小：不改向导、不改 lux 适配器、不改分发管线。

**Non-Goals:**

- 不取自动字幕（`automatic_captions`，站方 ASR 产物），不提供开关——质量未必胜过本地听写管线，混入会稀释「官方字幕可信、跳过听写」的价值主张。
- 不做字幕语言偏好配置（`--sub-langs`），走 yt-dlp 默认选择；多语言需求留后续。
- 不做 lux 引擎字幕能力、不抽取容器内嵌字幕流（mkv 封装字幕）、不做弹幕。

## Decisions

### D1. 只取官方字幕：`--write-subs`，绝不 `--write-auto-subs`

- 徽章语义与下载行为一致：预检 `subtitles` 非空才亮徽章、下载才有产物；`automatic_captions` 全程无视。
- 备选（放弃）：提供「含自动字幕」开关——自动字幕走本地 whisper 管线重新听写反而更可控，开关只会引导用户拿到更差的源。

### D2. 格式归一 srt：`--convert-subs srt`

- srt 是应用全链路通用语（校对/翻译/配音/烧录）；ffmpeg 已注入，转换零成本。
- 转换失败兜底：yt-dlp 转换失败时保留原格式，`.vtt/.ass` 亦在 `SUBTITLE_EXTENSIONS` 白名单内，链路仍通（认领扫描按白名单收，见 D4）。

### D3. 语言策略走 yt-dlp 默认（不加 `--sub-langs`）

- yt-dlp 默认取 en、无 en 取首个可用——每视频恰好一条字幕，与向导 1:1 配对模型最干净。
- 多语言站点偶发多文件时：配对规则按主干字典序取首个（确定性），向导内可手动指派换选（现有能力），未配对字幕不进任务。

### D4. 字幕文件认领：完成后按视频主干目录扫描（不解析日志行）

- 对 `--print after_move` 报告的每个视频路径，在同目录扫 `视频主干.*.{srt,vtt,ass}` 认领。
- 理由：`[info] Writing video subtitles to:` 日志行格式随版本可漂移（lux 进度解析已吃过输出漂移的亏）；目录扫描锚定在已契约化的 after_move 路径上，且扩展名白名单天然排除 `live_chat.json` 之类的非字幕产物。
- playlist 兜底单条目多视频：逐视频主干各扫一遍。

### D5. 交接语义：字幕跟随视频随行，面板级「携带字幕」开关兜底

- 字幕不独立勾选（脱离视频无交接意义）：勾选视频时其同主干字幕产物自动随行，行内以标记提示。
- 交接面板提供「携带官方字幕」开关（有字幕产物时显示、默认开）：部分条目无字幕的批次在向导会因未配对阻断，用户可关掉开关整批走纯 ASR，或在向导内移除/补配未配对行——两条逃生口都保留。
- 文件包装 `taskType:'media'` → `'any'`（`getDroppedFiles` 媒体+字幕双收），向导侧混合输入自动进配对模式，零改动。

### D6. 配置与数据模型：`writeSubs` 默认开，条目级 `subtitlePaths`

- `DownloadConfigSnapshot.writeSubs?: boolean`（默认 true、随其余下载配置记忆）；无官方字幕时 yt-dlp 仅告警不报错，默认开是纯增益。
- `DownloadEntryMeta.subtitleLangs?: string[]`（预检徽章数据源）；`DownloadEntry.subtitlePaths?: string[]`（条目「已取字幕」标记数据源）；artifacts 登记 `kind:'subtitle'`（沿用 path 去重）。
- lux 引擎（含失败回退到 lux）条目静默无字幕：适配器接口不强加字幕能力，`writeSubs` 仅 yt-dlp 适配器消费。

## Risks / Trade-offs

- [多语言官方字幕产多文件，配对歧义] → yt-dlp 默认语言选择通常单文件；多文件时字典序确定性取首 + 向导手动指派兜底。
- [yt-dlp 失败回退 lux 后遗留孤儿字幕文件] → 主干不同（lux 走 `-O` 命名）不会误配对；孤儿文件无害，不做清理。
- [断点续传/重试重复认领字幕] → artifacts 按 path 去重（scheduler 现有逻辑），幂等。
- [目录扫描误认领同主干旧文件] → `[id]` 唯一性 + `主干.` 前缀 + 扩展名白名单三重限定，重复下载同视频时认领同一批路径且去重。
- [部分有字幕批次交接被向导阻断，用户困惑] → D5 面板开关 + 向导既有未配对提示文案双重引导。

## Migration Plan

- `writeSubs`/`subtitleLangs`/`subtitlePaths` 均为可选字段扩展，旧 WorkItem 无需迁移。
- 回滚 = 关闭开关或移除参数追加，无数据破坏；已落盘字幕文件保留（用户资产）。

## Open Questions

- 字幕语言偏好（`--sub-langs` 配置项）与多语字幕全量下载——留待用户反馈后单独变更。

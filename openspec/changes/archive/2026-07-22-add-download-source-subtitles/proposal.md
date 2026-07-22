# Proposal: add-download-source-subtitles

## Why

YouTube 等站点的大量视频自带官方字幕（人工上传、可信度高），当前下载后仍要走完整 ASR 听写，费时费算力且质量可能不如源字幕。这是上一变更（add-video-downloader）显式列入范围外的「源站字幕直取」：基建已全部就绪，向导已有「媒体+字幕配对输入（跳过听写）」模式，字幕与视频同名落同目录即自动配对——本变更只需在下载侧写增量，整条 ASR 环节即可跳过。

## What Changes

- 预检标注官方字幕：yt-dlp 预检（`-J`）补读 `subtitles` 字段，含官方字幕的条目在预检列表展示「官方字幕」徽章（含语言列表）；仅统计人工字幕，`automatic_captions`（站方 ASR 自动字幕）不算——自动字幕质量未必胜过本地听写管线，不参与「跳过 ASR」的价值主张。
- 下载同取字幕：下载配置新增「同时下载官方字幕」开关（默认开、记忆）；开启时 yt-dlp 追加 `--write-subs --convert-subs srt`，字幕以 `视频主干.语言.srt` 落在保存目录（与视频同名同目录）；无官方字幕时静默跳过不报错。
- 字幕产物登记：下载完成后按视频主干认领字幕文件，登记为 WorkItem artifacts（`kind: 'subtitle'`），条目行展示「已取字幕」标记，最近任务页可定位。
- 交接携带字幕：「发送到任务流」时选中视频自动携带其同主干字幕（不独立勾选），向导收到混合文件后按既有配对模式自动配对、跳过听写；文件包装从 `taskType: 'media'` 切换为 `'any'`（媒体+字幕双收）。
- lux 引擎无字幕能力：路由或回退到 lux 的条目静默无字幕，预检徽章仅对 yt-dlp 条目有意义。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `video-download`: 三处增量——预检 requirement 增加官方字幕标注；新增「源站字幕直取」requirement（下载开关、落盘命名、artifacts 登记）；交接 requirement 增加字幕随行与向导自动配对语义。

（`pipeline-task-wizard` 零 delta：其「媒体+字幕配对输入（跳过听写）」requirement 原文已覆盖混合文件输入的自动配对与 `providedSubtitlePath` 直通语义，本变更正是复用这条现成杠杆。）

## Impact

- **types**: `types/download.ts` — `DownloadEntryMeta` 增 `subtitleLangs?: string[]`、`DownloadEntry` 增 `subtitlePaths?: string[]`、`DownloadConfigSnapshot` 增 `writeSubs?: boolean`。
- **main**: `videoDownload/parsers.ts`（预检 JSON 补读 `subtitles`）、`ytDlpAdapter.ts`（条件追加 `--write-subs --convert-subs srt`、按视频主干目录扫描认领字幕）、`engineAdapter.ts`（DownloadJobOptions/Result 扩展）、`scheduler.ts`（artifacts 登记 `kind:'subtitle'`、条目 subtitlePaths 推进）。
- **renderer**: `components/download/DownloadPanel.tsx` — 配置开关、预检徽章、条目「已取字幕」标记、交接字幕随行 + `getDroppedFiles` 切 `taskType:'any'`；zh/en `download.json` 文案。
- **不改**：向导（TaskWizard/filePairing/fileProcessor）、lux 适配器、下载器分发管线。

# Tasks: add-download-source-subtitles

## 1. 类型与预检解析

- [x] 1.1 `types/download.ts`：`DownloadEntryMeta` 增 `subtitleLangs?: string[]`、`DownloadEntry` 增 `subtitlePaths?: string[]`、`DownloadConfigSnapshot` 增 `writeSubs?: boolean`
- [x] 1.2 `main/helpers/videoDownload/parsers.ts`：`parseYtDlpPreflightJson` 补读 `subtitles` 字段（键为语言列表；`automatic_captions` 无视，剔除 live_chat/rechat 非语言键）填入 `subtitleLangs`；新增 `claimSubtitleFileNames` 认领纯函数（视频主干 + `.` 前缀 + srt/vtt/ass 白名单匹配，供适配器与单测共用）

## 2. 主进程：下载执行

- [x] 2.1 `engineAdapter.ts`：`DownloadJobOptions` 增 `writeSubs?: boolean`、`DownloadJobResult` 增 `subtitlePaths?: string[]`（lux 适配器不消费，无改动）
- [x] 2.2 `ytDlpAdapter.ts`：`writeSubs` 开启时追加 `--write-subs --convert-subs srt`；进程结束后对每个 after_move 视频路径按认领纯函数扫描同目录字幕文件（目录缓存 + 失败不阻断），填入 `subtitlePaths`
- [x] 2.3 `scheduler.ts`：`StartDownloadPayload.writeSubs` 入快照并透传下载任务（缺省视为开、仅 yt-dlp 消费）；条目完成时写入 `entry.subtitlePaths` 并登记 `kind:'subtitle'` artifacts（沿用 path 去重，重试/续传幂等）

## 3. 渲染进程：下载页

- [x] 3.1 输入态配置行增加「同时下载官方字幕」开关（默认开，`videoDownloadWriteSubs` 设置记忆、变更即持久化）
- [x] 3.2 预检确认态：`subtitleLangs` 非空条目展示「官方字幕」徽章与语言列表（>3 语言折叠为 +N）
- [x] 3.3 下载任务态：`subtitlePaths` 非空条目行展示「已取字幕」标记
- [x] 3.4 交接面板：存在字幕产物时显示「携带官方字幕」开关（默认开）；开启时选中视频的同主干字幕自动随行（行内「含字幕」标记，不独立勾选），`getDroppedFiles` 包装切 `taskType:'any'`；关闭时仅送媒体
- [x] 3.5 zh/en `download.json` 新增文案（开关、徽章、标记、随行提示）

## 4. 测试与验证

- [x] 4.1 单测扩展 `scripts/test-video-download.ts`：预检 `subtitles`/`automatic_captions` 解析区分（含 live_chat 剔除）、字幕认领纯函数（同主干多语言/无关文件/裸主干/近似主干/大小写/空主干），47 项全部通过
- [x] 4.2 端到端冒烟（2026-07-22，真实 yt-dlp 2026.07.04 二进制 + 代理）：正例《Me at the zoo》（官方字幕 de/en）以适配器同参数集实跑 → `视频主干.en.srt` 与视频同目录落盘（默认语言选择单文件，`--convert-subs` 转 srt 成功、cue 内容有效）、认领函数对真实产物命中；负例 Big Buck Bunny（无任何字幕）`--write-subs` 实跑 → exit 0、无字幕文件、无报错（静默跳过）；`check:i18n` 通过、单测 47 项通过、root/renderer tsc 对本变更触及文件零新增错误（既有别名/jest types 噪音除外）、ReadLints 无错误。应用内 UI 全链路（预检徽章 → 下载标记 → 交接随行 → 向导自动配对跳过听写）待用户真机验证

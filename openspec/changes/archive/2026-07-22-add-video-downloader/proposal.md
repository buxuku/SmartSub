# Proposal: add-video-downloader

## Why

用户的创作素材大量来自在线平台（YouTube、B站、抖音等），当前必须借助第三方工具下载后再手动导入本应用，链路割裂。内置在线视频下载能力后，「粘贴链接 → 下载 → 进入字幕/翻译/配音流水线」在应用内一站式闭环，显著降低素材获取门槛。

## What Changes

- 新增「视频下载」导航页（任务组内，位于启动台之后、字幕之前）：大输入框批量粘贴链接（一行一条，自动从混杂文本抽取 URL 并去重）、保存目录与清晰度选择；点击开始后翻转为下载任务态。
- 下载前预检：调用下载器解析元数据（标题/时长/清晰度/播放列表），失败项（登录墙、失效链接）前置暴露；播放列表 URL 需用户确认展开范围。
- 下载队列执行：每项展示进度/速度/ETA，支持取消、失败重试；全局进度接入状态栏 pill 与 ActivityCenter。
- 下载任务纳入 WorkItem 体系：新增 `download` 类型，持久化跨重启，中断项支持断点续传恢复。
- 完成后交接：批量选择已下载文件，跳转 `/tasks/new` 向导预填，走生成字幕/翻译/配音/自定义任务流。
- 双引擎下载器管理：yt-dlp（官方独立二进制）+ lux（自维护编译产物），运行时在线安装到 userData、应用内检查更新；分发复用既有 gitcode→ghproxy→gitcode 镜像回退与断点续传基建；按域名路由引擎并支持失败回退。
- 下载器子进程透传应用代理设置（`network/proxyManager`）。
- 范围外（后续变更）：链式自动化（下载完成自动进流水线）、源站字幕直取（--write-subs 跳过 ASR）、浏览器 Cookie 导入、纯音频下载模式。

## Capabilities

### New Capabilities

- `video-download`: 视频下载页交互流（粘贴解析 → 预检确认 → 队列下载 → 完成交接）、下载 WorkItem 数据模型与持久化、全局进度展示。
- `downloader-management`: 下载器二进制生命周期（版本清单、在线安装、应用内更新、镜像回退、完整性校验）与引擎路由（域名偏好表 + 失败回退）。

### Modified Capabilities

- `pipeline-task-wizard`: 新增外部交接预填入口——向导支持从下载页携带媒体文件列表进入并预填，其余目标勾选/阶段推导行为不变。

## Impact

- **renderer**: 新增下载页（`renderer/pages/[locale]/download.tsx` 及组件）；`Layout.tsx` 导航项与路由预取、CommandPalette 入口；`/tasks/new` 向导增加预填接收；新增 i18n 命名空间。
- **main**: 新增下载器管理器（安装/更新/版本清单）、下载执行器（spawn yt-dlp/lux、进度解析、队列调度）及对应 IPC handlers；复用 `helpers/download/*`（mirrorDownloader/resumeIntegrity/versionCompare）、`network/proxyManager`、`ffmpeg-static`（yt-dlp 合流依赖）。
- **types**: `WorkItemType` 增加 `'download'`；新增 `DownloadEntry` 等类型；workItemStore 兼容迁移。
- **外部维护产物**（代码库外，需单独建设）: buxuku/lux fork + builder workflow（goreleaser 定期构建 master → `latest` rolling release）；yt-dlp 与 lux 产物的 GitCode 镜像仓；`downloader-versions.json` 版本清单（同 addon-versions.json 模式）。
- **不引入**合规提示/免责声明。

# Tasks: add-video-downloader

## 1. 外部分发管线（先行，应用发版前必须就绪）

- [x] 1.1 建立分发仓 buxuku/smartsub-downloaders（实施调整：免 fork，CI 直接从 iawia002/lux master 源码交叉编译 + 搬运 yt-dlp 官方产物并校验官方 SHA256SUMS），周更 + 手动触发发布到 `latest` rolling release，全平台矩阵（win x64/arm64、darwin x64/arm64、linux x64/arm64）；管线文件仅维护在分发仓，主仓 `scripts/downloaders-dist/README.md` 记录跨仓契约（清单结构/平台键/仓库 slug/镜像资产清单）
- [ ] 1.2 GitCode 镜像仓：`sync-gitcode.sh` 已新增 `--target downloaders`（`npm run sync:downloaders`）；github/ghproxy 两源已验证可拉取。剩余：在国内机器上持 GITCODE_TOKEN 创建 buxuku1/smartsub-downloaders 并跑首次同步
- [x] 1.3 `downloader-versions.json` 清单已定义（`scripts/downloaders-dist/build-manifest.mjs` 生成）并随首次构建发布验证（yt-dlp 2026.07.04 + lux 2026.07.21，含各平台 SHA256/体积）

## 2. 类型与数据模型

- [x] 2.1 `types/workItem.ts`：`WorkItemType` 增加 `'download'`，WorkItem 增加 `downloadEntries?: DownloadEntry[]`；新增 `types/download.ts`（DownloadEntry、引擎标识、清单/安装状态类型 + extractUrls/routeEngines 纯函数）
- [x] 2.2 workItemStore 兼容：可选字段扩展无需数据迁移；启动中断标记对 download 类型专门处理（loading 条目回置 '' 支持续传）；workItemUtils/最近任务页/WorkItemList 数据链路打通

## 3. 主进程：下载器二进制管理

- [x] 3.1 `main/helpers/downloaderManager.ts`：清单拉取（5min 缓存 + 三源回退）、平台资产解析；安装 = mirrorDownloader + prepareDownloadTarget 断点续传 + SHA256 校验 + 原子落位 `userData/downloaders/{engine}/{version}/` + chmod
- [x] 3.2 更新流程：原子切换 + 保留上一版本目录（KEEP_PREVIOUS_VERSIONS=1）+ 更旧清理；getDownloaderStatuses 本地/远端状态查询
- [x] 3.3 IPC（并入 `ipcVideoDownloadHandlers.ts`）：getStatuses/install/cancelInstall/checkUpdates channels + `videoDownload:installProgress` 事件广播；执行中下载时拒绝更新（BUSY_DOWNLOADING）

## 4. 主进程：下载执行

- [x] 4.1 引擎适配器接口（`videoDownload/engineAdapter.ts`）+ yt-dlp 适配器：`-J --flat-playlist` 预检、`--newline --progress-template`（SMARTSUB-DL 哨兵）、`--print after_move` 取最终路径、`-c` 续传、`--proxy`/`--ffmpeg-location` 注入、`-S res:N` 就近降档；已用真实二进制端到端验证参数集
- [x] 4.2 lux 适配器：`-j` 预检、stdout 百分比解析 + 文件大小轮询降级（预检 totalBytes 估算）、环境变量代理、`-O` 命名输出 + 目录 diff 认领产物
- [x] 4.3 域名路由表（bilibili/b23.tv/douyin/ixigua/xiaohongshu/xhslink/kuaishou/weibo/zhihu → lux 优先，默认 yt-dlp）+ 失败自动换引擎重试一次 + 单引擎降级（`types/download.ts` routeEngines）
- [x] 4.4 下载调度器（`videoDownload/scheduler.ts`）：独立并发队列（默认 2，设置项 1–5）、单条取消/重试、整批取消（未完成条目回置待下载 + interrupted）
- [x] 4.5 WorkItem 生命周期：开始创建 download WorkItem、条目状态推进、artifacts 登记（kind:video）；启动 running→interrupted + 「继续下载」重新入列断点续传；删除任务联动停进程
- [x] 4.6 下载 IPC：preflight（并发 3）/start/resume/retryEntry（可选先更新引擎）/cancelEntry/cancelBatch/revealFile；entryChanged 节流 ≤2 次/秒/条目 + itemChanged + summary（变化才广播）

## 5. 渲染进程：下载页

- [x] 5.1 页面骨架与入口：`download.tsx` 页 + `components/download/`、Layout 导航项（启动台之后，CloudDownload 图标）、PREFETCH_NAMESPACES、CommandPalette 入口、zh/en `download.json` 命名空间（check:i18n 通过）
- [x] 5.2 输入态：批量粘贴（extractUrls 抽取去重计数、无有效链接禁用）、保存目录（selectDirectory + settings 记忆）、清晰度档位、引擎选择、并发数设置
- [x] 5.3 引擎安装引导卡 `EngineSetupCard`：未安装引导态/已装折叠态、一键安装 + 进度条、检查更新 + 更新按钮、BUSY 提示
- [x] 5.4 预检确认态：标题/时长/最高清晰度/引擎徽章、失败项标红原因、合集展开选择（仅此条/全部，>100 显式 confirm）、「直接下载」跳过预检路径
- [x] 5.5 下载任务态：条目进度/速度/ETA、单条取消/重试、整批取消/继续下载；MAYBE_OUTDATED 错误附「更新下载器后重试」快捷动作
- [x] 5.6 完成交接态：artifacts 默认全选 + 勾选调整 +「发送到任务流」；状态栏 videoDownloadPill（summary 事件驱动）；最近任务/ActivityCenter 经 workItemUtils 展示 download 类型并可回开 `?workItem=`

## 6. 向导交接预填

- [x] 6.1 交接链路：下载页 getDroppedFiles 包装 → WIZARD_DROP_KEY sessionStorage 预填（复用启动台链路）+ `?fromDownload=` 来源参数；失效路径包装期剔除并提示跳过数；向导 handleStart 写入 sourceDownloadWorkItemId；最近任务行「来自下载」徽章回溯（spec 已同步为如实描述）

## 7. 测试与验证

- [x] 7.1 单测 `scripts/test-video-download.ts`（npm run test:video-download，32 项通过）：extractUrls、routeEngines、versionCompare、yt-dlp 进度/预检解析、lux 进度/预检解析（含降级判定）、错误分类与裁剪
- [x] 7.2 集成冒烟：macOS 侧真实验证（分发 CI 构建发布 → github/ghproxy 拉取清单 → 二进制可执行 → yt-dlp/lux 预检与下载实跑，含 B 站 DASH 合并与命名两个缺陷修复回归）+ check:i18n、tsc、lint 通过；应用内 UI 全链路已由用户真机验证通过（2026-07-22）。GitCode 镜像同步归入 1.2 遗留项跟踪

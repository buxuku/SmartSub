# Proposal: add-downloader-cookie-import

## Why

匿名态下载受站点登录墙限制：B 站匿名只能取到 480P（lux 甚至仅 360P/480P），大会员专享清晰度、会员/年龄限制内容完全不可达；YouTube 会员视频与年龄限制视频同理。yt-dlp 与 lux 均已具备 cookie 消费能力（`--cookies` / `-c`），缺的只是应用侧的导入、存储与注入链路。这是 add-video-downloader 变更显式声明的范围外事项（archive/2026-07-22-add-video-downloader proposal Non-Goals），现补上。

## What Changes

- 新增「站点 Cookie 档案」管理：预设 bilibili（bilibili.com/b23.tv）与 youtube（youtube.com/youtu.be，附账号风控提示）档案 + 自定义域名档案；每档案独立存储（lux 会把文件内全部 cookie 发给每个请求，跨站混装会泄漏会话，按站点隔离是硬约束）。
- 三种导入方式：
  1. 从浏览器提取——以 yt-dlp `--cookies-from-browser` 作提取器导出 Netscape 文件（UI 标注兼容性：Firefox 全平台可靠；Windows Chrome 因 App-Bound Encryption 不可用；macOS Chrome 触发钥匙串授权）；
  2. cookies.txt 文件导入（浏览器扩展导出，全平台可靠兜底）；
  3. 粘贴原始 Cookie 串（`a=b; c=d`，应用合成 Netscape 行）。
- 导入时按档案域名白名单过滤；`safeStorage` 可用时加密落盘，不可用回退明文。
- 下载器 spawn 注入：预检与下载按条目 URL 匹配档案，解密到进程级临时副本后 yt-dlp 传 `--cookies`、lux 传 `-c`，进程结束删除副本（规避 yt-dlp 退出写回 cookie jar 的并发竞争）。
- 失效提示：档案管理界面展示导入时间/关键 cookie 过期时间/已过期徽章；带 cookie 条目失败且错误呈鉴权特征时，错误动作附「重新导入 Cookie」引导（复用 `MAYBE_OUTDATED::` 前缀模式）。
- 范围外（后续变更）：内嵌登录窗口（B 站扫码收割 session cookie）、站点特定的主动登录态校验。路由表行为不变（B 站仍 yt-dlp 优先），仅更新注释依据。

## Capabilities

### New Capabilities

（无——cookie 属于下载引擎执行环境的一部分，归入既有 downloader-management 能力）

### Modified Capabilities

- `downloader-management`: 新增「站点 Cookie 档案管理」requirement（导入/按域过滤/加密存储/过期展示/删除）；修改「下载器子进程环境注入」requirement（cookie 临时副本注入规则，lux 按站点隔离 MUST）；新增「Cookie 失效提示」requirement（静态过期展示 + 失败启发式引导）。

## Impact

- **main**: `main/helpers/videoDownload/`（engineAdapter cookie 解析/临时副本、ytDlpAdapter/luxAdapter 参数注入、scheduler 透传）、`main/helpers/ipcVideoDownloadHandlers.ts`（档案 CRUD + 浏览器提取 IPC）、新增 cookie 档案存储模块（`userData/downloader-cookies/`、safeStorage）。
- **renderer**: `renderer/components/download/DownloadPanel.tsx` 配置区新增「站点 Cookie」入口与管理对话框；`renderer/public/locales/{zh,en}/download.json` 文案。
- **types**: `types/download.ts` 新增 cookie 档案类型与 URL→档案匹配纯函数（含 b23.tv/youtu.be 别名表）。
- **tests**: `scripts/test-video-download.ts` 增补 Netscape 解析/合成、域名过滤、URL 匹配用例。
- 无新增第三方依赖；不改动下载器分发与路由表行为。

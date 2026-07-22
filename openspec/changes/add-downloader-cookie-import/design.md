# Design: add-downloader-cookie-import

## Context

yt-dlp/lux 双引擎下载链路已成型（archive/2026-07-22-add-video-downloader）：adapter 统一签名（`engineAdapter.ts`）、scheduler 队列调度、`ipcVideoDownloadHandlers` 暴露预检与批次操作、`buildChildEnv()` 注入代理与 ffmpeg。两引擎的 cookie 消费能力已就绪但应用侧未接线：

- **yt-dlp**：`--cookies <file>`（Netscape 格式，标准 cookiejar 按域匹配发送）；`--cookies-from-browser <browser>` 可直接读浏览器（Windows Chrome 因 App-Bound Encryption 自 Chrome 127 起不可用；macOS Chrome 触发钥匙串授权弹窗；Firefox 全平台明文 SQLite 可靠）。**退出时会把 cookie jar 写回 `--cookies` 文件**。
- **lux**：`-c` 接受原始 Cookie 串或文件路径（读文件后先按 Netscape 解析，失败当原始串）；已核实源码（`request/request.go`）：解析出的 cookie 经 `req.AddCookie` **无域名匹配地附到每个请求**——文件内跨站 cookie 会被发给任意目标站点。

约束：provider API key 现状为明文 electron-store；应用无浏览器 cookie 解密能力也不打算引入（ABE 后自研解密不可行且高维护成本）。

## Goals / Non-Goals

**Goals:**

- 站点 Cookie 档案：预设 bilibili/youtube + 自定义域名，按站点隔离存储，三种导入方式（浏览器提取/cookies.txt/粘贴原始串）。
- spawn 注入：预检与下载均按 URL 匹配档案传参（yt-dlp `--cookies`、lux `-c`），进程级临时副本隔离并发与加密。
- 失效可见：静态过期展示 + 失败启发式「重新导入 Cookie」引导。

**Non-Goals:**

- 内嵌登录窗口（B 站扫码收割 Electron session cookie）——后续独立变更（Google 系拒绝内嵌浏览器登录，非普适方案）。
- 站点特定的主动登录态校验（如调 B 站 nav 接口探活）——引入站点耦合，静态过期 + 失败启发式够用。
- 路由表行为调整：有 cookie 后 lux 对 B 站也能取高清，但 yt-dlp 优先无理由变动，仅更新注释依据。
- 多浏览器 profile/container 选择（`--cookies-from-browser` 的 `:PROFILE::CONTAINER` 语法）——v1 仅浏览器名，默认 profile。

## Decisions

### D1. 统一存储格式：Netscape cookies.txt，两引擎共用一份档案

yt-dlp `--cookies` 只吃 Netscape 文件；lux `-c` 自动识别 Netscape。因此档案主格式定为 Netscape 文本，三种导入方式全部归一到该格式落盘（粘贴的原始串按档案主域合成 Netscape 行：`.{domain}	TRUE	/	FALSE	0	name	value`，expiry=0 即会话 cookie，UI 标注「无过期信息」）。

序列化两条硬约束（实现踩坑，已回灌为约束 + 单测）：

1. **不回写 `#HttpOnly_` 前缀**。lux 用的 cookiemonster 解析器把任何 `#` 开头的行当注释整行丢弃（含 yt-dlp 约定的 `#HttpOnly_` 数据行），会吞掉 `SESSDATA`/`bili_jct` 等 HttpOnly 登录 cookie → lux 报「账号未登录」。HttpOnly 属性对「cookie 是否随请求发送」无影响，故解析时把前缀提取为 `httpOnly` 标记并从 domain 剥离，序列化统一写普通 domain 行；yt-dlp 与 lux 均能读。实测：带 `#HttpOnly_` 的文件 lux 报「账号未登录」、剥离后同一 cookie lux 见 1080P。
2. **expiry 归一到 Unix 秒**。Chrome 提取出的 expiry 是 Chromium 原生时间戳（自 1601 起的微秒，约 1.3e16），非标准 Unix 秒；不归一会让 `new Date` 溢出成 Invalid Date（UI）并可能误判过期。按数量级识别微秒/毫秒/秒归一（`normalizeExpiryToUnixSeconds`）。

备选（拒绝）：原始 Cookie 串为主格式——yt-dlp 无法消费（`--add-headers Cookie:` 会把 cookie 发给所有域，官方不推荐且有泄漏风险）。

### D2. 档案模型：按站点隔离 + 双域名表 + 匹配纯函数

lux 的无域名匹配发送（Context）使**按站点分文件成为安全硬约束**，非偏好。档案结构：

```ts
interface CookieProfile {
  id: string; // 'bilibili' | 'youtube' | 'custom-{uuid}'
  kind: 'preset' | 'custom';
  /** 条目 URL → 档案 匹配域（含短链别名） */
  matchDomains: string[]; // bilibili: ['bilibili.com','b23.tv']
  /** 导入过滤白名单（cookie 行的 domain 字段后缀匹配） */
  cookieDomains: string[]; // youtube: ['youtube.com','google.com']（登录态 cookie 分布在两域）
  importedAt?: number;
  source?: 'browser' | 'file' | 'paste';
  encrypted?: boolean;
}
```

- 预设表 `COOKIE_SITE_PRESETS` 放 `types/download.ts`（与 `LUX_PREFERRED_DOMAINS` 同居，b23.tv/youtu.be 别名与路由表同思路）；youtube 预设附风控提示文案键。
- 档案元数据存 electron-store（`videoDownloadCookieProfiles`），cookie 内容存 `userData/downloader-cookies/{profileId}.cookies`；目录仅存内容，索引单一来源在 store。目录名不用 `cookies`——macOS/Windows 大小写不敏感文件系统上会与 Electron 自身的 `userData/Cookies`（Chromium web cookie SQLite 库）撞路径导致 `mkdir` EEXIST。
- URL→档案匹配为纯函数 `matchCookieProfile(url, profiles)`（后缀域匹配，复用 `hostMatches` 逻辑），main/renderer 共用、可单测。
- 自定义档案默认 `matchDomains = cookieDomains = [输入域名]`。

备选（拒绝）：单一全局 cookie 文件——对 yt-dlp 安全（cookiejar 按域匹配）但对 lux 直接泄漏会话；导入时不过滤——用户选「导出全部 cookie」的文件时会把无关站点会话落盘，隐私面扩大。

### D3. 浏览器提取：以 yt-dlp 为提取器，不自研解密

`yt-dlp --cookies-from-browser <browser> --cookies <tmp-out> --skip-download <dummy-url>` 在 YoutubeDL 初始化时完成浏览器 cookie 提取、退出时（含提取 URL 失败的错误退出）写出 Netscape 文件。dummy URL 用 `http://127.0.0.1:0/`（连接秒败、零外网请求）；不看退出码，以「输出文件存在且含目标域行」为成功判据，随后按 D2 过滤落盘、删除中间文件。lux 借此间接获得浏览器导入能力（lux 官方无此功能，issue #1427 悬置）。

- UI 浏览器选项：Chrome / Edge / Firefox / Safari(仅 macOS) / Brave，附平台兼容性标注（Windows 隐藏 Chrome 或标注不可用；macOS Chrome 标注会弹钥匙串授权）。
- 提取失败（ABE、钥匙串拒绝、浏览器未安装）→ 错误信息引导改用 cookies.txt 文件导入（全平台兜底）。
- 前置检查：yt-dlp 未安装时禁用该导入方式（提示先安装引擎）。

备选（拒绝）：自研读取浏览器 cookie DB（rookiepy 类方案）——Windows ABE 后需 SYSTEM 级解密链，不可行且维护面大；要求用户装浏览器扩展导出——保留为方式 2，但不作唯一路径。

### D4. 加密与注入：safeStorage 加密落盘 + 进程级临时副本

- **落盘**：`safeStorage.isEncryptionAvailable()` 为真时 `encryptString` 后写 `{profileId}.cookies`（base64），否则明文写入；`encrypted` 标记存档案元数据。解密失败（如系统钥匙串重置）视为档案损坏：状态置「需重新导入」，不崩溃。
- **注入**：spawn 前 `matchCookieProfile` 命中 → 解密内容写入 OS 临时目录唯一文件（`smartsub-cookies-{uuid}.txt`），yt-dlp 传 `--cookies <tmp>`、lux 传 `-c <tmp>`，`runProcess` 结束后 finally 删除。临时副本同时解决两个问题：(1) yt-dlp 退出写回 cookie jar，多进程共写主档案会竞争损坏；(2) 加密主档案无法被子进程直接读取。
- 适配器保持无状态：`PreflightOptions`/`DownloadJobOptions` 增加可选 `cookieFilePath`，临时副本生命周期由调用方（scheduler `runEntry` / ipc `preflightOne`）以 `withCookieFile(url, fn)` 辅助函数管理。
- 未命中档案：不传任何 cookie 参数（现状行为）。

权衡：丢弃 yt-dlp 写回的轮换后 cookie（YouTube 会轮换会话 cookie），可能加速档案失效——接受，失效路径由 D5 兜底；回写主档案的一致性协调（锁/合并）复杂度不成比例。

### D5. 失效提示：静态过期 + 失败启发式，两层

- **静态**：档案状态由解密后内容即时计算（cookie 条数、关键 cookie 过期时间、已过期徽章）。关键 cookie 按预设表定义（bilibili→`SESSDATA`，youtube→`LOGIN_INFO`），自定义档案取全部 cookie 的最早过期时间。B 站登录失效常表现为静默降 480P 而非报错，静态过期展示是唯一前置信号。
- **失败启发式**：条目失败且本次执行**附带了 cookie** 且错误呈鉴权特征（403 / login / members only / premium / 大会员 / sign in 等关键词，`isLikelyAuthError` 落 `parsers.ts`）→ 错误加 `MAYBE_COOKIE_EXPIRED::` 前缀（复用 `MAYBE_OUTDATED::` 前缀模式），UI 动作条附「重新导入 Cookie」打开档案管理对话框。两前缀同时命中时 cookie 提示优先（带登录态时鉴权失败大概率是 cookie 问题而非引擎过旧）。

### D6. 预检同样注入

`ipcVideoDownloadHandlers.preflightOne` 与 scheduler 内 lux 元数据补拉走同一注入路径。收益：预检清晰度列表直接反映登录态（B 站可见 1080P+/大会员档位）、会员内容预检不再报「需登录」。

### D7. UI 归属：下载页配置区入口 + 独立管理对话框

`DownloadPanel` 配置行加「站点 Cookie」按钮（带已配置档案数徽标），打开 `CookieProfilesDialog`：预设档案 + 自定义添加，每档案展示状态行（来源/导入时间/过期状态）、三种导入入口、删除。IPC 面：`videoDownload:cookieProfiles`（list/importFile/importPaste/importFromBrowser/delete）。文案进 `download.json`（zh/en）。

## Risks / Trade-offs

- [lux 将档案内全部 cookie 发给该次下载的所有请求（含重定向后域）] → 按站点隔离 + 导入过滤把爆炸半径限制在单站点会话；b23.tv 短链重定向到 bilibili.com 恰依赖此行为（lux 不做域匹配反而让别名域拿到主域 cookie）。
- [Windows Chrome 浏览器提取永久不可用（ABE），用户预期落空] → UI 前置标注 + 失败错误直接引导 cookies.txt 导入路径；Firefox 标注为推荐提取源。
- [丢弃 yt-dlp 写回的轮换 cookie，YouTube 档案寿命缩短] → D5 失效引导兜底；文案提示 YouTube cookie 需定期重导。
- [YouTube 带 cookie 批量下载有账号风控风险] → youtube 预设档案 UI 附风险提示文案；不默认引导配置 YouTube。
- [safeStorage Linux 无 keyring 时回退明文] → 与既有 API key 明文存储同威胁模型，不劣化现状；`encrypted` 标记如实展示。
- [粘贴导入的会话 cookie（expiry=0）无过期信息，静态提示失明] → UI 标注「无过期信息」，失效依赖 D5 失败启发式。
- [dummy URL 提取流程依赖 yt-dlp「错误退出仍写 cookie 文件」行为] → 实现时在 macOS/Windows 实测验证；判据基于输出文件内容而非退出码，行为变化可及时暴露（tasks 含验证项）。

## Open Questions

- 浏览器多 profile 用户（如 Chrome 多人格）默认 profile 提取不到目标账号——v1 接受，观察反馈后再评估 `:PROFILE` 语法透出。
- 批次开始时若命中档案已过期，是否前置 toast 提醒（而非等失败）——留给实现时按 UI 噪音权衡，spec 不强制。

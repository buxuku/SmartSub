# downloader-management Specification

## Purpose

yt-dlp / lux 下载引擎二进制的分发与生命周期管理：自维护分发仓（buxuku/smartsub-downloaders）`latest` rolling release 携 `downloader-versions.json` 清单驱动在线安装与应用内更新，镜像回退（gitcode→ghproxy→github）适配国内网络；域名路由表 + 失败回退决定单条链接的执行引擎；子进程环境统一注入代理与随包 ffmpeg。跨仓契约见主仓 `scripts/downloaders-dist/README.md`（详见 archive/2026-07-22-add-video-downloader）。

## Requirements

### Requirement: 下载器在线安装

系统 SHALL 支持 yt-dlp 与 lux 两个下载引擎的运行时在线安装：二进制按 `downloader-versions.json` 版本清单解析平台资产，经既有镜像回退顺序（gitcode→ghproxy→github，遵循用户所选首选源）下载，支持断点续传；落位前 MUST 校验 SHA256，校验通过后原子落位到 `userData/downloaders/{engine}/{version}/`（macOS/Linux 落位后赋予可执行权限）。首次进入下载页且引擎未安装时 SHALL 展示安装引导卡，一键安装并展示进度。

#### Scenario: 首次进入引导安装

- **WHEN** 用户首次进入视频下载页且未安装任何引擎
- **THEN** 页面呈现安装引导卡，点击安装后展示下载进度，完成后自动进入可用态

#### Scenario: 镜像回退与完整性校验

- **WHEN** 首选下载源不可达或产物 SHA256 校验失败
- **THEN** 自动切换下一顺位源重试，全部失败时呈现错误与重试入口，不留下损坏的二进制

### Requirement: 下载器应用内更新

系统 SHALL 支持应用内检查与更新下载器：拉取版本清单与本地已装版本比较，存在新版本时在下载页与引擎管理入口展示更新提示，用户确认后按安装同等流程（镜像回退 + 校验 + 原子切换）更新；更新完成前旧版本 MUST 保持可用，切换后保留上一版本目录用于回退。条目下载失败时 SHALL 提供「更新下载器后重试」快捷动作。

#### Scenario: 检查到新版本并更新

- **WHEN** 版本清单中 yt-dlp 版本高于本地已装版本
- **THEN** 展示更新提示，确认后下载新版本并原子切换，期间进行中的下载不受影响

#### Scenario: 失败驱动的更新引导

- **WHEN** 某条目下载失败且判定可能与引擎版本相关（提取器错误）
- **THEN** 错误信息附带「更新下载器后重试」动作，执行后以新版本重试该条目

### Requirement: 引擎路由与失败回退

系统 SHALL 内置「域名 → 引擎偏好」路由表（douyin.com、ixigua.com、xiaohongshu.com、kuaishou.com、weibo.com、zhihu.com 等 → lux 优先；bilibili.com/b23.tv 及未命中域名 → yt-dlp。B 站不走 lux 优先的依据：匿名态 lux 仅能取到 360P/480P 流，yt-dlp 可取到 1080P）。引擎选择为「自动」时按路由表执行；首选引擎失败后 MUST 用另一引擎自动重试一次，两个引擎均失败才判定条目失败（错误信息含两次失败原因）。用户 SHALL 可对整批手动指定引擎（跳过路由与回退换引擎）。仅安装了单引擎时路由 MUST 降级为该引擎。

#### Scenario: lux 优先域路由

- **WHEN** 引擎为「自动」且链接为抖音分享链接
- **THEN** 该条目由 lux 执行下载

#### Scenario: B 站按清晰度优势路由到 yt-dlp

- **WHEN** 引擎为「自动」且链接为 bilibili.com 或 b23.tv
- **THEN** 该条目由 yt-dlp 执行下载（失败仍回退 lux）

#### Scenario: 失败自动换引擎

- **WHEN** yt-dlp 下载某条目失败
- **THEN** 系统自动改用 lux 重试该条目一次，成功则条目引擎标记为 lux

#### Scenario: 单引擎降级

- **WHEN** 用户仅安装了 yt-dlp，链接为抖音（lux 优先域）
- **THEN** 条目直接由 yt-dlp 执行，不因 lux 未安装而失败

### Requirement: 下载器子进程环境注入

spawn 下载器子进程时系统 SHALL 注入应用代理配置（yt-dlp 以 `--proxy` 显式传参，lux 以环境变量），并注入随包 ffmpeg 供音视频合流：yt-dlp 传 `--ffmpeg-location`；lux 依赖 PATH 查找，随包 ffmpeg 目录 MUST 前置注入子进程 PATH。代理配置变更后新发起的下载 MUST 使用新配置。

预检与下载 spawn 前系统 SHALL 按条目 URL 匹配站点 Cookie 档案（后缀域匹配，含 b23.tv/youtu.be 别名）：命中时将档案内容解密写入进程级临时副本，yt-dlp 传 `--cookies <临时副本>`、lux 传 `-c <临时副本路径>`，子进程结束后 MUST 删除临时副本（主档案 MUST NOT 直接暴露给子进程——yt-dlp 退出时写回 cookie jar，多进程共写会竞争损坏）；未命中档案时 MUST NOT 传任何 cookie 参数。lux 因对文件内 cookie 不做域名匹配（全量附到每个请求），传给 lux 的 cookie 文件 MUST 仅含该条目所属站点档案的内容。

#### Scenario: 代理透传

- **WHEN** 用户在设置中配置了 HTTP 代理后下载 YouTube 链接
- **THEN** 下载器请求经该代理发出

#### Scenario: DASH 合流可用

- **WHEN** yt-dlp 下载需要音视频分离合流的 1080p 视频
- **THEN** 合流使用应用随包的 ffmpeg 完成，产出单一媒体文件

#### Scenario: lux DASH 分离流合并

- **WHEN** lux 下载 B 站等站点需要音视频合并的 DASH 流
- **THEN** 合并使用 PATH 注入的随包 ffmpeg 完成产出单一成品；`[N]` 分片中间产物 MUST NOT 被认领为成品，合并失败时报出可操作的明确错误

#### Scenario: B 站登录态高清下载

- **WHEN** 已配置 bilibili 档案（含有效 SESSDATA），下载 bilibili.com 视频
- **THEN** yt-dlp 以 `--cookies` 临时副本执行，可取到登录态清晰度（1080P+/大会员档位），进程结束后临时副本被删除

#### Scenario: 预检反映登录态

- **WHEN** 已配置 bilibili 档案，预检一条 B 站链接
- **THEN** 预检同样注入 cookie，清晰度列表含登录态档位，会员限定内容不再报「需登录」

#### Scenario: 短链别名命中档案

- **WHEN** 已配置 bilibili 档案，下载 b23.tv 短链（失败回退到 lux 执行）
- **THEN** lux 以 `-c` 收到仅含 bilibili 档案内容的临时副本，重定向后的 bilibili.com 请求携带登录态

#### Scenario: 未命中档案不传参

- **WHEN** 未配置任何档案（或条目域名无匹配档案）时下载
- **THEN** 子进程参数不含 `--cookies`/`-c`，行为与本变更前一致

#### Scenario: 并发下载互不干扰

- **WHEN** 同一 bilibili 档案下两条 B 站条目并发下载
- **THEN** 各自持有独立临时副本，主档案内容不被子进程修改

### Requirement: 站点 Cookie 档案管理

系统 SHALL 提供按站点隔离的 Cookie 档案：预设 bilibili（匹配域 bilibili.com/b23.tv）与 youtube（匹配域 youtube.com/youtu.be；cookie 域含 youtube.com/google.com，UI MUST 附账号风控风险提示）档案，并支持添加自定义域名档案。每个档案 SHALL 独立存储为 Netscape 格式文件（`userData/downloader-cookies/{profileId}.cookies`，目录名避免与 Electron 自身 `userData/Cookies` 在大小写不敏感文件系统上撞路径），`safeStorage` 可用时 MUST 加密落盘、不可用时回退明文并如实标注；档案元数据（来源/导入时间/加密标记）存 electron-store。Netscape 序列化 MUST NOT 回写 `#HttpOnly_` 前缀（lux 的 cookiemonster 会把 `#` 开头行当注释丢弃，导致 SESSDATA 等 HttpOnly 登录 cookie 被吞），并 MUST 将 Chromium 原生微秒时间戳归一为 Unix 秒。系统 SHALL 支持三种导入方式并在导入时按档案 cookie 域白名单过滤（丢弃无关站点 cookie 行）：

1. 从浏览器提取：以 yt-dlp `--cookies-from-browser` 作提取器（浏览器选项按平台标注兼容性：Windows Chrome 不可用、macOS Chrome 触发钥匙串授权、Firefox 全平台可靠），yt-dlp 未安装时该方式 MUST 禁用；权限不足（macOS 完全磁盘访问）或浏览器未安装 SHALL 呈可操作错误提示；
2. cookies.txt 文件导入（浏览器扩展导出的 Netscape 文件）；
3. 粘贴原始 Cookie 串（`a=b; c=d`），系统按档案主域合成 Netscape 行（会话 cookie，无过期信息）。

档案 SHALL 可删除（删除文件与元数据）。下载页配置区 SHALL 提供档案管理入口并展示已配置档案数；导入失败信息 SHALL 在管理对话框内联展示（持久可读，不用短 toast 截断长文案）。

#### Scenario: cookies.txt 导入并按域过滤

- **WHEN** 用户在 bilibili 档案导入一个同时含 bilibili.com 与 twitter.com cookie 行的 cookies.txt
- **THEN** 仅 bilibili.com 域的行落盘，档案状态显示导入时间与 cookie 条数，twitter.com 行被丢弃

#### Scenario: 浏览器提取成功

- **WHEN** macOS 用户对 bilibili 档案选择「从 Firefox 提取」且 Firefox 中已登录 B 站
- **THEN** 系统经 yt-dlp 提取并过滤出 bilibili.com cookie 写入档案，中间产物删除，档案呈已配置态

#### Scenario: 浏览器提取不可用时引导兜底

- **WHEN** Windows 用户尝试从 Chrome 提取（App-Bound Encryption 导致不可用），或选择未安装的浏览器、macOS 无完全磁盘访问权限
- **THEN** 对话框内联展示可操作错误（前置标注不可用 / 引导授予完全磁盘访问 / 引导改用 cookies.txt 文件导入）

#### Scenario: 粘贴原始 Cookie 串

- **WHEN** 用户在 bilibili 档案粘贴 `SESSDATA=xxx; bili_jct=yyy`
- **THEN** 系统合成 `.bilibili.com` 域的 Netscape 行落盘，档案过期状态标注「无过期信息」

#### Scenario: 删除档案

- **WHEN** 用户删除 youtube 档案
- **THEN** cookie 文件与元数据移除，后续 YouTube 链接下载不再附带 cookie

### Requirement: Cookie 失效提示

档案管理界面 SHALL 展示各档案的静态失效信息：cookie 条数、关键 cookie 过期时间（预设档案按关键 cookie 名：bilibili→SESSDATA、youtube→LOGIN_INFO；自定义档案取最早过期时间）、已过期徽章。条目下载失败时，若本次执行附带了 cookie 且错误呈鉴权特征（403/login/members only 等），错误信息 SHALL 以 `MAYBE_COOKIE_EXPIRED::` 前缀标记并在 UI 提供「重新导入 Cookie」快捷动作（打开档案管理对话框）；该前缀与 `MAYBE_OUTDATED::` 同时命中时 MUST 以 cookie 提示优先。cookie 文件解密失败（如系统钥匙串重置）时档案 SHALL 呈「需重新导入」态而非崩溃。

#### Scenario: 过期徽章展示

- **WHEN** bilibili 档案的 SESSDATA cookie 过期时间早于当前时间
- **THEN** 档案管理界面该档案显示已过期徽章

#### Scenario: 鉴权失败引导重新导入

- **WHEN** 附带 bilibili cookie 的条目下载失败且错误含 403 鉴权特征
- **THEN** 条目错误带「重新导入 Cookie」动作，点击打开档案管理对话框定位到 bilibili 档案

#### Scenario: 未带 cookie 的鉴权失败不误导

- **WHEN** 未配置任何档案的条目因需要登录而下载失败
- **THEN** 错误不带 `MAYBE_COOKIE_EXPIRED::` 前缀，不出现「重新导入 Cookie」动作

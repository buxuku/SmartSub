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

#### Scenario: 代理透传

- **WHEN** 用户在设置中配置了 HTTP 代理后下载 YouTube 链接
- **THEN** 下载器请求经该代理发出

#### Scenario: DASH 合流可用

- **WHEN** yt-dlp 下载需要音视频分离合流的 1080p 视频
- **THEN** 合流使用应用随包的 ffmpeg 完成，产出单一媒体文件

#### Scenario: lux DASH 分离流合并

- **WHEN** lux 下载 B 站等站点需要音视频合并的 DASH 流
- **THEN** 合并使用 PATH 注入的随包 ffmpeg 完成产出单一成品；`[N]` 分片中间产物 MUST NOT 被认领为成品，合并失败时报出可操作的明确错误

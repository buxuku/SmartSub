# Design: add-video-downloader

## Context

应用已具备本功能所需的几乎全部基建，本设计的主线是「复用而非新造」：

- **镜像下载基建** `main/helpers/download/*`：mirrorDownloader（gitcode→ghproxy→github 三源回退，`downloadSourceOrder.ts` 国内优先）、resumeIntegrity（断点续传 + SHA256 校验）、versionCompare、extractArchive。
- **自编译分发模板**：whisper.cpp addon 由 buxuku/whisper.cpp builder 分支定期构建、发布到 `latest` rolling release（GitCode 镜像 buxuku1/whisper.node），清单文件 `addon-versions.json` 驱动应用内更新。lux 照抄此模式。
- **代理管理** `network/proxyManager.ts`：已有全局代理设置，下载器子进程需透传（YouTube 等站点刚需）。
- **ffmpeg**：`ffmpeg-static` 已随包分发（app.asar.unpacked），yt-dlp 合流 DASH 音视频依赖它，零新增成本。
- **WorkItem 任务体系**：`types/workItem.ts` + workItemStore 持久化 + 最近任务页 + ActivityCenter/状态栏 pill。
- **任务向导** `/tasks/new`：接收文件列表、目标产物勾选推导阶段链，是下载完成后的交接目标。

外部事实（2026-07 核实）：yt-dlp 官方 release 活跃（月更 stable + nightly），提供全平台独立二进制与 `_update_spec`；lux 官方二进制停在 v0.24.1（2024-05）但 master 持续合并 PR，仓库自带 goreleaser 配置，自编译成本低。

## Goals / Non-Goals

**Goals:**

- 应用内闭环：粘贴链接 → 预检 → 批量下载 → 一键交接进既有任务流。
- 双引擎（yt-dlp + lux）在线安装与应用内更新，国内网络可用（镜像回退）。
- 下载任务持久化为 WorkItem，跨重启可恢复（断点续传）。
- 引擎能力可扩展：后续接入 BBDown / N_m3u8DL-RE 等只需新增引擎适配器与路由表项。

**Non-Goals:**

- 链式自动化（下载完成自动进流水线）、源站字幕直取（--write-subs）、浏览器 Cookie 导入、纯音频模式——留待后续变更（数据模型为其预留字段即可，不实现）。
- 不做站点级功能定制（弹幕、大会员番剧等 BBDown 专属能力）。
- 不打包下载器进安装包，不引入合规提示。
- 不做下载限速、定时下载。

## Decisions

### D1. 双引擎：yt-dlp 主力 + lux 国内站补充，域名路由 + 失败回退

- yt-dlp 覆盖 1800+ 站点、维护最活跃，作默认引擎；lux 对抖音/西瓜/小红书等国内站点适配更好。
- 路由：内置「域名 → 引擎偏好」表（douyin.com、ixigua.com、xiaohongshu.com、kuaishou.com、weibo.com、zhihu.com 等 → lux 优先），未命中 → yt-dlp。B 站（bilibili.com/b23.tv）实施中调整为 yt-dlp 优先：实测匿名态 lux 仅能取 360P/480P 流，yt-dlp 可取 1080P（清晰度差近 4 倍体积）。首选引擎失败后自动用另一引擎重试一次，UI 默认「自动」并允许对整批手动指定引擎。
- 备选方案：单引擎 yt-dlp（放弃，国内站体验打折）；cobalt（放弃，依赖服务端，不符桌面离线形态）；BBDown/N_m3u8DL-RE（不首发，引擎适配器接口为其留扩展位）。

### D2. yt-dlp 采用官方独立二进制（而非 zipimport + 内嵌 Python）

- 产物：win x64 `yt-dlp.exe`（~17MB）/ win arm64 / macOS universal `yt-dlp_macos`（~37MB）/ linux x64 & aarch64。
- 理由：零耦合——不依赖 py-base 运行时的路径与版本演进；官方产物有签名与 SHA256SUMS，完整性校验直接可用。代价是更新包体积较大（vs zipimport 3MB），由镜像分发缓解。

### D3. lux 自维护编译：fork + builder workflow → rolling release

- buxuku/lux fork 增加定时 workflow（goreleaser 构建 master），产物发布到 `latest` rolling release，同步 GitCode 镜像仓——与 whisper.cpp addon 维护管线完全同构。
- 平台矩阵与 yt-dlp 对齐：win x64/arm64、darwin x64/arm64、linux x64/arm64（lux 为 Go 单二进制，交叉编译零成本）。

### D4. 分发与更新：自维护版本清单 + mirrorDownloader（不用 yt-dlp 自带 `-U`）

- `downloader-versions.json`（模式同 `addon-versions.json`）声明各引擎当前版本、各平台资产名与 SHA256，随 rolling release 发布并镜像。
- 应用内检查更新 = 拉清单 + versionCompare；下载走 mirrorDownloader 三源回退 + resumeIntegrity 断点续传。
- 不用 yt-dlp `-U`：它直连 GitHub（国内不可达），且绕过应用的完整性校验与版本管理，会造成两套更新事实。
- 版本策略：清单固定「经测试的版本」而非盲追 latest，站点破坏性变化时可快速发新清单推送更新。

### D5. 二进制落位 userData，版本化目录 + 原子切换

- `userData/downloaders/{engine}/{version}/`，下载至临时文件 → SHA256 校验 → rename 原子落位 → 更新 `meta.json` 指向当前版本；旧版本目录保留一份用于回退，再旧的清理。
- macOS 产物落位后 `chmod +x`；应用内 Node https 下载不带 quarantine 属性，无 Gatekeeper 弹窗问题。
- 首次进入下载页检测未安装 → 引导卡一键安装（体验对齐现有模型/加速包安装）。

### D6. 下载任务并入 WorkItem，但执行队列独立于 taskProcessor

- 类型层：`WorkItemType` 增加 `'download'`；WorkItem 新增可选字段 `downloadEntries?: DownloadEntry[]`（与 pipelineFiles/proofreadEntries 并列）。一次「开始下载」动作 = 一个 WorkItem，粘贴的每条链接 = 一个 DownloadEntry。

```ts
interface DownloadEntry {
  id: string;
  url: string;
  engine: 'yt-dlp' | 'lux'; // 实际执行引擎（含回退后）
  status: '' | 'loading' | 'done' | 'error'; // 沿用阶段字符串状态机约定
  progress?: number;
  speed?: string;
  eta?: string;
  meta?: {
    title?: string;
    duration?: number;
    thumbnail?: string;
    playlistCount?: number;
  };
  outputPath?: string; // 完成后的媒体文件绝对路径
  error?: string;
}
```

- 执行层：新建独立的下载调度器（并发默认 2、设置可调 1–5），**不进** taskProcessor——转写队列是计算密集单通道，下载是 IO 密集可并行，混用会互相饿死。WorkItem 仅作为共享的持久化与展示模型。
- 恢复语义：启动时 running 的下载 WorkItem 标记 interrupted（沿用现有机制）；「继续下载」用 yt-dlp `-c` / lux 的续传能力从断点恢复。
- `configSnapshot` 存 `{ savePath, quality, engine: 'auto'|..., concurrency }`，并为后续链式自动化预留 `autoChain` 字段位。

### D7. 预检与进度解析：结构化优先，降级兜底

- 预检：yt-dlp `-J --flat-playlist`（拿标题/时长/清晰度/播放列表条目数，不下载）；lux 路由的域名用 `lux -j`。播放列表在预检态要求用户确认展开范围（全部/仅本条），超大列表（>100 条）默认截断需显式确认。预检失败不阻断——用户可选择「跳过预检直接下载」。
- 进度：yt-dlp 用 `--newline --progress-template` 输出机器可读行，逐行解析；lux 解析其 stdout 进度文本，解析失败时降级为轮询输出文件大小估算百分比（lux 预检已知总大小）。
- 进度经 IPC 节流广播（≤2 次/秒/条目），沉淀到状态栏 pill 与 ActivityCenter 复用现有 downloadPill 模式。

### D8. 交接：跳转 `/tasks/new` 向导预填（不直接创建流水线 WorkItem）

- 完成态勾选文件 →「发送到任务流」→ 携带文件路径列表跳转向导；向导侧新增预填入口（复用 `getDroppedFiles` 的 IFiles 包装链路），用户在向导内选目标产物、走既有就绪校验后开始。
- 理由：向导已承担目标推导/阶段配置/就绪校验，绕过它直接建 WorkItem 会复制这套逻辑且失去配置机会。下载 WorkItem 与交接产生的流水线 WorkItem 之间记录来源引用（downloadWorkItemId），最近任务页可回溯。

### D9. 子进程环境：代理与 ffmpeg 注入

- spawn 下载器时按 proxyManager 当前配置注入 `HTTP_PROXY/HTTPS_PROXY`（yt-dlp 亦可用 `--proxy` 显式传参，取显式传参以避免环境变量歧义）。
- yt-dlp 传 `--ffmpeg-location` 指向随包 ffmpeg-static 路径（复用 `ffmpeg.ts` 的 asar.unpacked 解析）。

## Risks / Trade-offs

- [lux stdout 进度解析随版本漂移] → 降级文件大小轮询兜底；解析器与自编译版本一同锁定（清单固定版本，升级时同步验证解析器）。
- [站点反爬变化导致批量失败] → 失败项提供「更新下载器后重试」快捷动作；清单驱动的快速版本推送。
- [双引擎版本矩阵维护成本（外部 CI + 镜像同步）] → 与 whisper.cpp addon 管线同构复用运维心智；清单固定版本降低回归面。
- [播放列表误展开造成海量下载] → 预检确认 + >100 条显式确认；队列支持整批取消。
- [Windows 杀软对 yt-dlp.exe 误报] → 官方签名产物 + SHA256 校验落位；文档 FAQ 说明；不重命名官方二进制。
- [标题含非法字符/超长导致落盘失败] → 依赖 yt-dlp/lux 自带的跨平台文件名清洗，输出模板固定 `%(title)s [%(id)s].%(ext)s` 保证唯一性。
- [下载与转写并发抢占磁盘/带宽] → 下载并发默认保守（2）；两队列互不阻塞由 D6 保证。

## Migration Plan

- workItemStore：新增类型为可选字段扩展，旧数据无需迁移（`WORK_ITEM_MIGRATION_VERSION` 不变或 +1 仅登记）。
- 功能自包含（新页面 + 新 helpers），回滚 = 移除导航入口，无数据破坏。
- 外部产物先行：lux builder workflow 与镜像仓、`downloader-versions.json` 需在应用发版前就绪并验证三源可达。

## Open Questions

- lux GitCode 镜像仓命名与同步方式（复用 buxuku1 组织的现有同步脚本 `scripts/sync-gitcode.sh` 是否直接适用）——实施 M1 时确认。
- 清晰度选项的粒度（固定档位 1080p/720p/最佳 vs 暴露格式选择器）——首版取固定档位 + 「最佳」，预检返回不满足时就近降档。

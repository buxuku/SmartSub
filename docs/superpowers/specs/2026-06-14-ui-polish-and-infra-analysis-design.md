# 校对面板/引擎中心 UI 收口 + 版本与代理基建分析（设计）

> 状态：设计/待评审（item 2/3/4/5/6/7/8/9/10 待实现）
> 日期：2026-06-14
> 分支：`feat/multi-engine`
> 关联：`docs/superpowers/specs/2026-06-14-multi-engine-review-qwen-upgrade.md`
> 来源：用户提出的 10 个问题（item 1 已处理；item 4/6 经二次确认纳入本批实现）
> 视觉稿：`docs/mockups/proofread-mockup.html` / `docs/mockups/proofread-mockup.png`

本文把用户提出的批量问题整理成可执行设计。**item 1（git 分叉）已在本次会话直接处理完毕**（见 §1）。其余均为本批实现：UI 收口（§2、§3）+ 两项基建（§4：item 4 下载器架构统一、item 6 全局网络代理）。

---

## 0. 结论速览（TL;DR）

| Item        | 主题                            | 形态     | 主要落点                                                                                     |
| ----------- | ------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| 1           | 远程多一次提交                  | ✅已处理 | 已核对内容等价性后 `--force-with-lease` 覆盖远程                                             |
| 2           | 翻译状态“翻译失败 0/6”误导      | 实现     | `SubtitleList.tsx` 顶部状态栏改“全部/成功/失败”友好统计                                      |
| 3.1/3.2/3.3 | 单行截断、需展开全部、字体切换  | 实现     | `SubtitleList.tsx` 增“展开全部”开关 + “小/中/大”字号                                         |
| 5           | 引擎文案                        | 实现     | `resources.json`(zh/en)：M 系列；删长录音尾句                                                |
| 7           | localCli 命令默认收起           | 实现     | `EnginesTab.tsx` 删自动展开 effect                                                           |
| 8           | 下载/升级弹窗按钮缺统一 icon    | 实现     | `EnginesTab.tsx` 两个 AlertDialog footer 加 icon                                             |
| 9           | 代理命名不一致                  | 实现     | `resources.json`+`settings.json`：统一“github 国内加速”                                      |
| 10          | 日志弹窗底部按钮不固定          | 实现     | `LogDialog.tsx` 改 flex 列 + 正文 flex-1 + footer 常驻                                       |
| 4           | 下载器/版本管理统一（Option C） | 实现     | 抽共享 `MirrorDownloader` 核心；addon/py 下载器退化为薄适配层；统一 base-URL 解析（见 §4.1） |
| 6           | 全局网络代理                    | 实现     | `global-agent` 全覆盖；设置新增“网络代理”卡片（none/custom）（见 §4.2）                      |

---

## 1. item 1 · 远程分叉（已处理，留档）

现象：`feat/multi-engine` 相对 `origin/feat/multi-engine` **ahead 29 / behind 1**。

诊断：远程那 1 个提交是 `2de49c9 feat: simplify settings, unify resource hub UX, add global engine indicator`（merge-base = `c80886d feat: support faster-whisper`）。它是同一批工作的“大爆炸版”，本地后来把它**重做成 29 个原子提交**。核对证据：

- `git merge-tree --write-tree` 显示仅 4 个文件冲突：`fasterWhisperEngine.ts`、`EnginesTab.tsx`、`resources.json`(en/zh)；其余 2de49c9 触碰的文件在本地**逐字节一致**（docs 图、`HelpHint.tsx`、`ipcHandlers.ts`、`systemInfoManager.ts` 等）。
- 4 个冲突文件里，远程独有的“将被丢弃”行只有 3 条：两条 `desc` 是**更短的旧版**（本地已是更长的新版，正是 item 5 要改的那两段），一条 `downloadConfirm` 为 diff 错位（本地仍存在）。

结论：本地是**功能超集**，远程那次提交已被取代。已执行 `git push --force-with-lease origin feat/multi-engine`，本地与远程同步，无内容丢失。**本项无需进入实现计划。**

---

## 2. WS-A · 校对面板（item 2、3）

文件：`renderer/components/subtitle/SubtitleList.tsx`、`renderer/public/locales/{zh,en}/home.json`。
现状关键点：

- 顶部状态栏在 `SubtitleList.tsx:544` 起，且整段被 `shouldShowTranslation &&` 包裹（纯转写无该栏）。
- 失败统计在 `:549-552`：`{t('translationFailed')}: {failedIndices.length} / {mergedSubtitles.length}`，且恒带 `AlertTriangle`（即“全部成功也显示 ⚠ 翻译失败 0/6”的根因）。
- 行组件 `SubtitleRow`：非当前行走紧凑单行（`:152-178`，`truncate`），当前行走展开可编辑态（`:181-277`）。

### 2.1 item 2 · 友好状态统计

把 `:546-553` 的失败统计替换为状态感知摘要：

- 无失败：绿色 `CheckCircle2` + `全部 N · 成功 N · 失败 0`。
- 有失败：橙色 `AlertTriangle`（`text-warning`）+ `全部 N · 成功 X · 失败 Y`，其中“失败 Y”高亮（`text-destructive`/`font-semibold`）。
- 右侧的“只看失败 / 上一条 / 下一条 / 重翻失败”保持不变（仅在有失败时出现，沿用现逻辑）。

渲染示例：`全部 6 · 成功 6 · 失败 0`（用 `·` 连接，`tabular-nums`）。

### 2.2 item 3.2 · 一键展开/收起全部

- 在 `SubtitleList` 增状态 `expandAll`（初值读 `localStorage['proofread:expandAll']`）。
- 顶部状态栏右侧新增按钮：`expandAll ? 收起全部 : 展开全部`（图标 `ChevronsDownUp` / `ChevronsUpDown`，lucide 已可用同族图标，缺则用 `Rows3`/`Unfold`）。点击翻转并写回 localStorage。
- 行渲染条件由“仅当前行展开”改为 `展开 = (index === currentSubtitleIndex) || expandAll`：
  - `SubtitleRow` 增 `forceExpanded` prop，内部 `const expanded = isCurrent || forceExpanded;`，用 `expanded` 取代原 `isCurrent` 的分支判断（紧凑 vs 展开）。
  - 展开态背景：当前行保留 `bg-accent`；`expandAll` 下的非当前行用更轻的 `bg-card`，避免整列高亮。
- 虚拟化保持：`useVirtualizer` 仍只挂载可视行；`estimateSize` 依 `expandAll` 调整（收起 34，展开 ~110），真实高度仍由 `measureElement` 兜底。长列表性能不受影响。
- 与“只看失败”可叠加：两个开关相互独立。

### 2.3 item 3.3 · 字体 小/中/大

- 增状态 `fontScale: 's' | 'm' | 'l'`（初值读 `localStorage['proofread:fontScale']`，默认 `'m'`）。
- 顶部状态栏新增分段控件 `小 / 中 / 大`（三个紧凑按钮，选中态 `bg-primary/5 text-primary`）。
- 字号映射（应用到行正文与展开态 textarea）：`s→text-[11px]`、`m→text-xs(12px，现状)`、`l→text-sm(14px)`。通过把 `fontScale` 传入 `SubtitleRow`，由 row 选择正文/译文/textarea 的字号类实现；时间戳、#编号等元信息字号不随之放大（保持信息密度）。
- 收起与展开两种视图都生效。

### 2.4 状态栏常驻（让控件在纯转写下也可用）

- 现状状态栏整段 `shouldShowTranslation &&` 包裹；改为**状态栏常驻**：外层容器始终渲染；仅“成功/失败统计 + 只看失败 + 重翻”这部分继续 `shouldShowTranslation &&`，而“展开全部 + 字号”在两种模式都显示。
- 纯转写模式下状态栏仅含视图控件（展开全部、字号），不显示翻译统计。

### 2.5 新增 i18n（home.json）

| key                | zh               | en                  |
| ------------------ | ---------------- | ------------------- |
| `transStatTotal`   | `全部 {{count}}` | `All {{count}}`     |
| `transStatSuccess` | `成功 {{count}}` | `Success {{count}}` |
| `transStatFailed`  | `失败 {{count}}` | `Failed {{count}}`  |
| `expandAll`        | `展开全部`       | `Expand all`        |
| `collapseAll`      | `收起全部`       | `Collapse all`      |
| `fontSizeLabel`    | `字体`           | `Font`              |
| `fontSizeSmall`    | `小`             | `S`                 |
| `fontSizeMedium`   | `中`             | `M`                 |
| `fontSizeLarge`    | `大`             | `L`                 |

> 保留旧键 `translationFailed`、`translationFailedLabel`（后者仍用于行内“翻译失败”后缀）。

---

## 3. WS-B · 文案与交互收口（item 5、7、8、9、10）

### 3.1 item 5 · 引擎文案（`resources.json` zh/en）

- `engines.builtin.desc`：
  - zh：`苹果芯片（M1/M2/M3）有专属优化` → `苹果芯片（M 系列）有专属优化`。
  - en：`Apple silicon (M1/M2/M3)` → `Apple silicon (M series)`。
- `engines.fasterWhisper.desc`：
  - zh：删除句尾 `，适合处理 1 小时以上长录音、批量转写多个文件`（保留到“普通 Windows 电脑也更快。”）。
  - en：删除 ` — ideal for recordings over an hour and batch-transcribing many files.`（保留到“…faster on regular Windows PCs too.”）。

### 3.2 item 7 · localCli 命令配置默认收起

`EnginesTab.tsx`：删除 `:171-177` 的自动展开 `useEffect` 及 `commandConfigInitRef`（`:95`）。`showCommandConfig` 默认 `false` 即保持收起；用户点击“配置命令”才展开（手动开合逻辑不变，`:768-783`）。

### 3.3 item 8 · 下载/升级弹窗按钮统一 icon

`EnginesTab.tsx` 两个 AlertDialog（下载 `:836-857`、升级 `:859-880`）footer：

- `AlertDialogCancel`：加 `className="gap-1.5"` + `<X className="h-4 w-4" />` + 取消文案。
- 下载 `AlertDialogAction`：`<Download className="h-4 w-4" />` + 文案。
- 升级 `AlertDialogAction`：`<ArrowUpCircle className="h-4 w-4" />` + 文案。

（`Download`/`ArrowUpCircle` 已在该文件导入；`X` 需补充导入 `from 'lucide-react'`。风格对齐其余主按钮的 `gap-1.5`。）

### 3.4 item 9 · 代理命名统一为“github 国内加速”

| 文件                  | key                       | 旧值                             | 新值                    |
| --------------------- | ------------------------- | -------------------------------- | ----------------------- |
| `zh/resources.json:4` | `ghProxy`                 | `Gh代理`                         | `github 国内加速`       |
| `en/resources.json:4` | `ghProxy`                 | `GH Proxy`                       | `GitHub Mirror (China)` |
| `zh/settings.json:82` | `gpuAcceleration.ghProxy` | `GitHub 代理 (国内加速)`         | `github 国内加速`       |
| `en/settings.json:82` | `gpuAcceleration.ghProxy` | `GitHub Proxy (Faster in China)` | `GitHub Mirror (China)` |

> 使用方仅展示用途：`EnginesTab.tsx:411`、`CudaDownloadSheet.tsx:307`，无逻辑改动。
> **不改**模型下载的 `modelsControl.domesticMirror`（“国内加速源（更快）”）——经用户确认保持原样（模型走 HuggingFace 官方源/国内加速源两选一，与这里的三源 GitHub Release 选择器是两套机制）。

**三源排列顺序统一（用户补充要求）：** 所有“三个下载源”选择器统一顺序为 `['github', 'ghproxy', 'gitcode']`，即显示 **GitHub · github 国内加速 · GitCode**。

| 文件                    | 位置                                            | 现状顺序                   | 处理         |
| ----------------------- | ----------------------------------------------- | -------------------------- | ------------ |
| `EnginesTab.tsx`        | `:393`（renderBinarySourceSelector，py-engine） | `github, ghproxy, gitcode` | 已一致，锁定 |
| `CudaDownloadSheet.tsx` | `:290`（GPU/cuda addon）                        | `github, ghproxy, gitcode` | 已一致，锁定 |

> 现状两处已经同序，本要求作为“验收项”固化：实现/评审时核对两个选择器渲染顺序完全一致；若日后新增第三个三源选择器须沿用同一顺序。
> 备注：自动回退顺序 `getSourceFallbackOrder`（`downloadSourceOrder.ts`，国内优先 gitcode→ghproxy→github）是**重试策略**，与 UI 展示顺序是两件事，保持现状不动。如果你更希望 UI 也按“国内优先”展示（gitcode/ghproxy/github），这是一处一行改动，可在实现阶段二选一。

### 3.5 item 10 · 日志弹窗底部按钮固定

文件：`renderer/components/LogDialog.tsx`。根因：`DialogContent` 基类是 `grid + overflow-hidden + max-h`（`ui/dialog.tsx:39`），而本弹窗正文用固定 `h-[60vh]`（`:82`）、footer 是普通 `mt-4` div（`:105`）。窗口高度小时，header+60vh+footer 超过 `max-h-[80vh]`，被 `overflow-hidden` 裁掉底部 → 按钮不可见。

修复（标准“可滚动正文 + 常驻 footer”模式，与拆分弹窗一致）：

- `DialogContent`：`className="max-w-3xl max-h-[80vh] flex flex-col"`（`flex` 经 tailwind-merge 覆盖基类 `grid`）。
- `ScrollArea`：去掉 `h-[60vh]`，改 `className="flex-1 min-h-0"`。
- 头部/底部不收缩：footer 改用 `DialogFooter`（或保留 div 并加 `shrink-0`），确保始终可见。

验收：把应用窗口高度压到很小，复制/清空按钮仍固定可见，日志区在剩余空间内滚动。

---

## 4. WS-C · 基建实现（item 4、6）

### 4.1 item 4 · 下载器架构统一（Option C：共享 MirrorDownloader 核心）

> 用户决策：选 **Option C**（最大重构，面向长期可维护性与健壮性）。本节是“行为保持（behavior-preserving）”的架构重构，**不改任何下载 UX、不改 release 产物、不动 sidecar 协议**。

#### 4.1.1 背景核对（现状已比分析时更完备）

关联 spec 把 py-engine 版本/升级标为“未实现”，但**当前代码已落地**，item 4 不再需要补功能，只需消除重复：

- py-engine `manifest.json` 已带真实 `engineVersion`/`protocolVersion`/`builtAt`/`gitSha`（`types/engine.ts:16-25`、`downloader.ts:464-478`）；远端有 manifest 时取真版本，缺失才回退 `latest`（"vlatest" 已基本消解）。
- 更新检测已做：`checkUpdate()` 用 sha256 比对 + 协议区间校验（`downloader.ts:420-462`）；每日节流静默检查已接（`autoUpdateCheck.ts`、`background.ts:182`）。
- 安全升级已做：停 sidecar → `current→previous` 备份 → swap → 写 manifest → ping 自检 → 失败回滚（`downloader.ts:480-626`）。
- addon：日期版本 `YYYY.MM.DD` + `normalizeVersion` 字符串比较 + 多源回退 + sha256/sizes（`addonVersions.ts`）。CUDA 非独立版本体系，只是 addon 变体 key（保持不动；命名一致由 item 9 覆盖）。

**真正重复的是“下载管线”机制本身**（两份近乎逐行相同的实现）：

| 重复点                                               | `AddonDownloader`（`addonDownloader.ts`）                                   | `PyEngineDownloader`（`pythonRuntime/downloader.ts`）                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 断点续传单文件下载 `downloadFile`                    | `:382-567`                                                                  | `:628-803`（逻辑等价：Range 续传、3xx 重定向递归、206 `content-range` 解析、60s 无活动超时 + 30s 连接超时、abort、进度+状态持久化） |
| 进度/速度/ETA/百分比 `updateProgress`+`sendProgress` | `:161-202`                                                                  | `:186-221`（仅 IPC channel 名不同）                                                                                                 |
| 多源回退主循环 `download`                            | `:219-248`                                                                  | `:235-268`（仅“终止类错误”判定不同）                                                                                                |
| 续传状态读写                                         | `readDownloadState/saveDownloadState`（含 `cudaVersion`→`variant` 兼容）    | 同名函数，state 形状不同                                                                                                            |
| sha256                                               | 复用 `calculateFileChecksum/verifyChecksum`（`addonDownloader.ts:716-740`） | `import { calculateFileChecksum }`（已跨文件复用）                                                                                  |

**差异（适配层各自保留）：**

- 进度 IPC channel：`addon-download-progress` vs `py-engine-download-progress`。
- 续传 state 文件路径与字段：addon 带 `variant/downloadType`；py 带 `tag/source`。
- 下载后处理：addon = `extractFile`（清目录 + tar/gunzip + 找/改名 `.node`，**不校验 sha256**）；py = 强制校验 sha256 → staging 解压 → `normalizePyEngineLayout` → 安全 swap（停机/备份/ping/回滚）。
- 下载前处理：py 有“拉远端 manifest + 协议区间”预检；addon 无。
- 终止类错误（不换源）：addon 仅 `Download cancelled`；py 还有 `protocol_unsupported`。
- **镜像仓库 slug 不同（务必保留）**：addon `github=buxuku/whisper.cpp`，但 `gitcode=buxuku1/whisper.node`（owner + repo 名都不同）；py `github=buxuku/smartsub-py-engine`，`gitcode=buxuku1/smartsub-py-engine`（owner 不同）。

#### 4.1.2 目标架构

新增目录 `main/helpers/download/`：

1. `sources.ts` —— 统一 base-URL 解析，取代 `DOWNLOAD_SOURCES`（`addonDownloader.ts:24-29`）与 `getPyEngineReleaseBaseUrl`（`paths.ts:177-189`）：

```ts
type DownloadSourceId = 'github' | 'ghproxy' | 'gitcode';
interface ReleaseRepoSlugs {
  github: string;
  gitcode: string;
} // 两者 slug 不同，必须分开传
function resolveReleaseBaseUrl(
  source: DownloadSourceId,
  slugs: ReleaseRepoSlugs,
  tag: string,
): string;
// github:  https://github.com/{slugs.github}/releases/download/{tag}
// ghproxy: https://ghfast.top/<上面的 github url>
// gitcode: https://gitcode.com/{slugs.gitcode}/releases/download/{tag}
```

> addon 侧 `getAddonFileName/getDownloadUrl/getAddonVersionsUrl` 与 py 侧 `getPyEngineDownloadUrl/...ChecksumsUrl/...ManifestUrl` 改为基于本函数的薄封装；URL 字符串结果须与现状逐字符一致（含 addon 现有的末尾 `latest/`）。

2. `mirrorDownloader.ts` —— 共享下载核心（把两份 `downloadFile`+`updateProgress`+回退循环合一）。核心**不感知** addon/py 的产物语义，全部经依赖注入：

```ts
interface MirrorDownloadJob {
  source: DownloadSourceId; // 用户选择，内部走 getSourceFallbackOrder
  resolveUrl: (s: DownloadSourceId) => string; // 各源产物 URL
  tempPath: string;
  state: DownloadStateStore; // read()/save()/clear()，各自沿用原 JSON 形状/路径
  onProgress: (p: ProgressSnapshot) => void; // 适配层转成各自 IPC + 进度类型
  isTerminalError?: (e: unknown) => boolean; // 默认仅 cancel；py 追加 protocol_unsupported
  preflight?: (s: DownloadSourceId) => Promise<void>; // py：拉 manifest + 协议门禁
  finalize: (tempPath: string, s: DownloadSourceId) => Promise<void>; // addon：extract；py：verify+staging+swap
}
class MirrorDownloader {
  constructor(opts: { onProgress; getAbort? });
  download(job: MirrorDownloadJob): Promise<void>; // 续传/重定向/超时/回退/取消全在此
  cancel(): void;
}
```

3. `AddonDownloader` / `PyEngineDownloader` 退化为**薄适配层**：保留各自**公开 API 与 IPC channel 完全不变**（`download/cancel/getProgress/setMainWindow/checkUpdate` 等签名一致，渲染层零改动），内部构造 `MirrorDownloader`，提供 `resolveUrl/finalize/preflight/isTerminalError` 与 progress→IPC 映射。`verifyExtractAndInstall/installFromStaging/rollback/extractFile/renameNodeFile` 等**产物特有逻辑留在各自适配层**（它们不是重复点）。

4. `versionCompare.ts`（小工具，收口版本比较）：导出 `compareDateVersion(a,b)`（把 `addonVersions.ts:131-178` 的 `normalizeVersion` + `>` 抽出），addon 改用它；py 维持 sha256 检测（对 rolling latest 是正确信号，不强行套版本号比较）。

#### 4.1.3 健壮性约束（用户重点：避免引入 bug）

行为保持是硬性验收口径：

- **公开 API / IPC channel / 进度字段 不变**：渲染层无改动、无新 IPC。
- **续传向后兼容**：state 文件路径与 JSON 字段保持现状（含 addon 的 `cudaVersion→variant` 兼容分支），升级覆盖安装后“进行中的续传”仍可继续。
- **校验差异保持**：addon 维持现状“不校验 sha256”（本次不顺手加校验，避免镜像间 checksum 不一致引发的新失败）；py 维持强制校验。差异点单列为后续可选项。
- **超时/重定向/206/abort 数值与分支逐一对齐**：60s 无活动、30s 连接、3xx 递归续传、206 `content-range`。
- **终止类错误语义保持**：cancel 不换源；py 的 `protocol_unsupported` 不换源。
- **gitcode slug 差异保持**（见 4.1.1）。

#### 4.1.4 测试

`scripts/test-engine-units.ts` 已存在，追加**纯逻辑**单测（不打真网络）：

- `resolveReleaseBaseUrl` 对 github/ghproxy/gitcode × addon/py 两套 slug 的输出，断言与重构前旧函数逐字符一致（可临时对拍）。
- `compareDateVersion`：`2026.06.10` vs `2026-06-10`、跨月/跨年、相等。
- 续传 Range 头与 `startByte` 计算、206 `content-range` 总长解析、终止类错误判定、进度 速度/ETA/百分比 数学。

手动矩阵（关键路径，至少 macOS dev + 一次 Windows）：全新下载 / 中断后续传 / 屏蔽 github 触发镜像回退 / 取消，覆盖 addon 与 py-engine 两条线；py 额外验证升级停机→swap→ping→回滚仍正常。

### 4.2 item 6 · 全局网络代理（实现：global-agent / none+custom）

> 用户决策：方案 **A（global-agent）**；模式 **none + custom**（不做 system / SOCKS）；设置页新增“网络代理”卡片。

#### 4.2.1 为什么 global-agent 能全覆盖（代码核对）

- 所有主进程下载/版本探测走原生 `https.get`/`http.get` 且**只传 `headers`、不传 `agent`**：`addonDownloader.ts`、`pythonRuntime/downloader.ts`、`addonVersions.ts:61-114`、`paths.ts`。
- 所有翻译服务走裸 `axios.post(...)`、**无 `httpsAgent`/`proxy`**：`main/service/{tencent,doubao,ollama,azure,google,baidu,deeplx,niutrans,xunfei}.ts`。
- 渲染层网络基本经 IPC 到主进程 → **主进程装一个全局 agent 即可覆盖 下载 + 翻译 + 更新检测**三条流，无需逐处改。`global-agent` 给全局 http/https agent 注入代理，未显式传 agent 的请求自动走代理。

#### 4.2.2 设置项（`store/types.ts` + `store/index.ts` defaults）

```ts
proxyMode?: 'none' | 'custom';   // 默认 'none'
proxyUrl?: string;               // custom 时必填，如 http://user:pass@host:port
proxyNoProxy?: string;           // 可选，逗号分隔；默认 'localhost,127.0.0.1'
```

#### 4.2.3 主进程接线

新增 `main/helpers/network/proxyManager.ts`：

- `bootstrapGlobalAgent()`：进程内**只调一次** `global-agent` 的 `bootstrap()`。
- `applyProxyFromSettings()`：读 `settings.proxyMode/proxyUrl/proxyNoProxy`，写/清 `process.env.GLOBAL_AGENT_HTTP_PROXY`、`GLOBAL_AGENT_HTTPS_PROXY`、`GLOBAL_AGENT_NO_PROXY`。`none` → 清空三个变量（等于关代理）。global-agent **每请求动态读 env** → **改完即时生效、无需重启**。
- `testProxyConnectivity(url?)`：按当前 env 向轻量端点（默认 `https://www.gstatic.com/generate_204`，可配）发 GET/HEAD，返回 `{ ok, ms, status?, error? }`。
- 接线点：`background.ts` 的 async IIFE **早期、任何联网前**（在 `setupStoreHandlers()` 之后、`maybeAutoCheckPyEngineUpdate` 之前）调用 `bootstrapGlobalAgent()` + `applyProxyFromSettings()`。

#### 4.2.4 IPC + 设置页 UI

- IPC：新增 `main/helpers/ipcNetworkHandlers.ts`，三个 handler：`proxy:get-config`、`proxy:set-config`（写 store → `applyProxyFromSettings()`）、`proxy:test`（调 `testProxyConnectivity`）。在 `background.ts` 的 `setupIpcHandlers` 一带注册；`preload` 暴露对应方法（沿用现有 ipc 封装约定）。
- UI：设置页新增**“网络代理 / Network Proxy”卡片**（参照现有设置卡片样式，如 `GpuAccelerationCard.tsx`）：模式单选 `不使用 / 自定义`；选 `自定义` 时显示 URL 输入（占位 `http://127.0.0.1:7890`）+ 可选 NO_PROXY 输入；“测试连通性”按钮显示 成功(耗时ms)/失败(原因)；保存即调用 `proxy:set-config`。
- i18n：`settings.json`(zh/en) 新增 `proxy.*`（title/modeNone/modeCustom/urlLabel/urlPlaceholder/noProxyLabel/test/testOk/testFail/saved 等）。

#### 4.2.5 边界与非目标

- 显式传 `agent` 的请求会绕过 global-agent —— 已审计：现有下载/axios 均未传，安全；后续新增网络代码若自带 agent 需登记。
- `electron-updater`（应用自更新）走自身网络栈，**本期不纳入**（单列后续）。
- `system`（读系统代理/PAC）与 `SOCKS`（需 `socks-proxy-agent`）**本期不做**，结构预留 `proxyMode` 便于将来扩展。
- `NO_PROXY` 默认放行 `localhost,127.0.0.1`（本地 sidecar 为 stdio，不受影响；此项主要为将来扩展留口）。

#### 4.2.6 依赖与测试

- 依赖：`yarn add global-agent` + `yarn add -D @types/global-agent`。
- 测试：`applyProxyFromSettings` 对 none/custom 的 env 读写（纯逻辑单测）；手动用本地代理（如 7890）验证一条下载 + 一条翻译均经代理；填错误代理时“测试连通性”如实报失败、关代理后恢复。

---

## 5. 测试与验收

- **WS-A**：
  - item2：构造全成功/部分失败两种字幕，确认状态文案与配色、无失败时不出现 ⚠。
  - item3.2：点击“展开全部”→ 所有行多行可编辑；长列表滚动流畅；刷新后状态保持。
  - item3.3：小/中/大切换正文字号即时生效；刷新后保持；纯转写模式下控件可用。
- **WS-B**：
  - item5：引擎卡片文案为“M 系列”、faster-whisper 描述无尾句（中英）。
  - item7：首次进入引擎页 localCli “配置命令”为收起。
  - item8：下载/升级弹窗取消/主操作均带 icon 且风格统一。
  - item9：资源中心与 GPU 设置处均显示“github 国内加速”（en: GitHub Mirror (China)）；两个三源选择器渲染顺序一致（GitHub · github 国内加速 · GitCode）。
  - item10：窗口高度压到很小，日志弹窗复制/清空按钮仍固定可见、日志区滚动。
- **WS-C（基建）**：
  - item4：纯逻辑单测（`resolveReleaseBaseUrl` 三源×两套 slug 与旧函数对拍、`compareDateVersion`、续传/206/终止类错误/进度数学）全过；手动矩阵（全新/续传/镜像回退/取消，addon+py 两线；py 升级 swap/回滚）通过；**渲染层无改动、IPC channel 与进度字段不变、续传 state 向后兼容**。
  - item6：本地代理开启后下载+翻译均经代理；none 时直连；“测试连通性”对正确/错误代理如实回报；改设置即时生效无需重启。
- 通用：`yarn`（项目）类型检查/构建无新增错误；改动文件过 lint。

## 6. 范围之外 / 决策记录

- item 1：已处理，不进实现计划。
- item 4：用户改判**纳入实现，选 Option C**（共享 `MirrorDownloader` 核心 + `resolveReleaseBaseUrl` + `compareDateVersion`），定位为**行为保持的架构重构**；不改下载 UX、不改 release 产物、不动 sidecar 协议；addon 维持“不校验 sha256”现状（加校验单列后续）。
- item 6：用户改判**纳入实现**，方案 A（global-agent），模式 **none+custom**（不做 system/SOCKS），设置页新增“网络代理”卡片；`electron-updater` 自更新本期不纳入。
- item 9：不改 `modelsControl.domesticMirror`（用户确认）；三源选择器顺序统一 `GitHub · github 国内加速 · GitCode`。
- en 代理标签统一为 `GitHub Mirror (China)`（用户确认）。
- 不做无关重构；WS-A 仅在 `SubtitleList.tsx` 内增视图控件，不改 hooks 数据层。

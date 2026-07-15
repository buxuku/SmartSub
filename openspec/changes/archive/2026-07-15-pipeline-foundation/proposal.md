# Proposal: 全流程流水线地基（P1）

## Why

产品方向已定：把听写/翻译/校对/配音/合成重构为「一条主流水线的可组合子集 + 人工闸门」（视频→字幕→翻译→配音→合成一条龙，批量执行，文件级到闸即停）。动工前有三块跨模块地基缺失，且每块独立交付即有用户价值：

1. **配音会话即焚**：行级合成结果（wav、状态、行级音色覆盖）存于临时目录、会话销毁即删，重开工作台全部重合成——云端引擎意味着重复计费。这直接堵死「配音闸门校对后放行继续下游」与批量配音的可能性。
2. **配音+字幕成品要两次全量编码**：配音导出（替换/混音/双轨）与字幕烧录是两次独立 ffmpeg 重编码，用户手动穿针引线、耗时翻倍。
3. **合成是全局单例**：`currentMergeCommand` 一次只能跑一个且无队列，批量合成与流水线驱动无从谈起。

## What Changes

- **配音会话持久化**：会话工作目录从临时目录迁至应用数据目录，行级状态与产物（wav、cue 状态、行级 voice 覆盖、实测时长）落盘；重开配音工作台恢复已合成行，不再全量重合成。
- **统一合成引擎（compose）**：合并字幕烧录与配音轨封装为单个 ffmpeg 合成引擎，支持「字幕（无/软封/硬烧）× 音轨（原声/替换/混音/双轨）」矩阵**单遍编码**；配音顺延过时间轴时自动优先使用顺延版字幕。既有画质档位、编码方式（CPU/硬件）、硬件失败回退、faststart 等编码要求原样适用于含硬烧的合成作业。
- **合成作业队列化**：合成从单例改为作业队列（作业句柄 + 全局编码槽，默认 1 路），排队作业可取消，进度事件携带作业标识。
- **合成工作台新增「配音音轨」可选输入**：单文件即可「字幕+配音一遍出片」；不选音轨时界面与行为与现状完全一致。
- **配音工作台导出改走统一合成引擎**：视频类输出形态（替换/混音/双轨）收敛到 compose 引擎执行，行为等价；仅音频输出路径不变。

不包含（留给后续 change）：流水线编排引擎与 StagePlan、批量配音/批量合成的任务化、闸门交互、配方与启动台改版。

## Capabilities

### New Capabilities

- `compose-engine`: 统一合成引擎——字幕×音轨单遍合成矩阵（含顺延字幕优先、流复制最小化重编码原则）、合成作业队列与编码槽、合成工作台的配音音轨输入与音轨模式选择。
- `dubbing-session-persistence`: 配音会话持久化——持久工作目录与行级状态落盘、字幕未变时的会话恢复、字幕已变/产物缺失的降级语义、随工作项删除的清理联动。

### Modified Capabilities

- `dubbing-workbench`: 新增「会话恢复」交互要求——重开工作台（含从最近任务回开）时恢复行级合成状态与可回放产物，用户可继续未完成行而非全量重跑。

## Impact

- **主进程**：`main/helpers/dubbing/dubbingProcessor.ts`（会话工作目录与状态落盘、恢复 API）、新增 `main/helpers/compose/`（统一命令构建器，吸收 `subtitleMerger.ts` 烧录分支与 `dubbing/audioPipeline.ts` 的封装路径）、`ipcSubtitleMergeHandlers.ts` / `ipcDubbingHandlers.ts`（队列化 IPC 与导出改道）、`main/helpers/store/`（会话索引与清理）。
- **渲染层**：`renderer/components/subtitleMerge/`（配音音轨输入、音轨模式控件、排队状态展示）、`renderer/components/dubbing/` + `hooks/useDubbing.ts`（会话恢复交互）、`renderer/public/locales/{zh,en}/{subtitleMerge,dubbing}.json`。
- **类型**：`types/subtitleMerge.ts`（ComposeConfig/作业与队列类型）、`types/dubbing.ts`（会话持久化元数据）、`types/workItem.ts`（dubbing 工作项关联会话引用）。
- **兼容性**：合成偏好、字幕样式、既有 `subtitleMerge:`/`dubbing:` IPC 返回形制保留；无音轨输入的合成行为与现状逐字节等价（滤镜与编码参数不变）；配音 audioOnly 导出路径不变。
- **依赖**：无新增二进制依赖（复用打包 ffmpeg 与既有取消/回退模式）。

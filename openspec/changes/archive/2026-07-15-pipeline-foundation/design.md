# Design: 全流程流水线地基（P1）

## Context

产品方向：任务模式重构为「主流水线（听写→翻译→配音→合成）可组合子集 + 人工闸门」，批量执行、文件级流动。本 change 是四步走（P1 地基 → P2 流水线核心 → P3 闸门 → P4 配方）的第一步，只做跨模块前置能力，不引入流水线编排本身。

现状约束（探索结论）：

- 配音会话（`dubbingProcessor.ts`）状态只存内存 Map，行级 wav 落在 `tmp/dubbing/<sessionId>/`，`disposeSession` 即删；workItem 只存路径快照，重开 = 全量重合成。
- 字幕烧录（`subtitleMerger.ts`）与配音轨封装（`dubbing/audioPipeline.ts`）是两套独立 ffmpeg 路径；「配音+字幕」成品需两次全量重编码。
- 合成执行体是全局单例（`currentMergeCommand`），一次一个、无队列。
- 烧录侧刚完成 ASS 预生成管线与硬件编码（含失败自动回退），这些行为要求（`subtitle-burn-*`、`merge-encoder-selection`）必须原样保留。

## Goals / Non-Goals

**Goals:**

- 配音行级状态与产物持久化，重开可恢复，为闸门（P3）与批量配音（P2）提供地基。
- 单个统一合成引擎支撑「字幕 × 音轨」矩阵单遍编码，重编码次数最小化。
- 合成从单例变作业队列，为批量合成（P2）铺路；单文件场景体验不变。
- 每项能力独立可用：即使 P2 不动工，「重开不重合成」「字幕+配音一遍出片」已是用户价值。

**Non-Goals:**

- 不做流水线编排引擎、StagePlan、批量任务化（P2）。
- 不做闸门交互与"检查员模式"（P3）。
- 不做配方、启动台改版、新建任务向导（P4）。
- 不改变配音对齐引擎、TTS 引擎层、烧录样式系统的任何行为。
- 不做人声/伴奏分离等新音频能力。

## Decisions

### D1. 配音会话持久化：应用数据目录 + session.json 元数据

会话工作目录从 `tmp/dubbing/<sessionId>/` 迁至 `userData/dubbing-sessions/<sessionId>/`，内含行级 wav 与 `session.json`（字幕路径 + 字幕内容 hash、视频路径、配置快照、cues 数组：index/text/status/voiceId/appliedSpeed/synthesizedMs/wav 相对路径/error）。

- **为什么不放字幕同目录 sidecar（如校对的 `.smartsub-proofread`）**：行级 wav 体积大（长片可达数百 MB），属"可再生缓存"而非用户交付物，不应污染用户媒体目录；校对 sidecar 是轻量 JSON，性质不同。
- **写盘策略**：行级事件（合成完成/失败/接受变速/换 voice/文本编辑）触发节流写（沿用 workItemStore 的 800ms 防抖模式），崩溃后最多丢最近一拍。
- **恢复合法性判定**：以字幕内容 hash 为准——hash 一致才恢复行状态与产物；不一致（用户外部改过字幕、校对重写过交付物）提示重建会话；单行 wav 文件缺失时仅该行降级回待合成。
- **workItem 关联**：dubbing 类 workItem 的 `configSnapshot` 增加 `sessionId`；从最近任务回开按 sessionId 恢复。删除 workItem 联动删除会话目录。`disposeSession`（换文件）不再删目录，只释放内存。

备选：把 cue 状态并进 workItem 主存储——否决，行级数据量大且更新频繁，会放大 workItems 整表防抖写的成本；独立 session.json 按会话隔离。

### D2. 统一合成引擎：纯函数命令构建器 + 独立 runner

新增 `main/helpers/compose/`：

- `composeCommandBuilder.ts`：纯函数 `buildComposeArgs(config)`，吸收 subtitleMerger 的硬烧/软封分支与 audioPipeline 的 replace/mix/addTrack 封装，输出完整 ffmpeg args。可单测（无需执行 ffmpeg 断言 args）。
- `composeRunner.ts`：执行、进度解析、取消、半成品清理、硬件失败自动回退（回退逻辑从 subtitleMerger 迁移至此层，对含音轨的作业同样生效）。
- 矩阵语义：`subtitle: none | soft | hard(style/quality/encoderMode)` × `audio: keep | replace(track) | mix(track, ducking) | addTrack(track)`。
- **最小化重编码原则**：视频流仅在 `hard` 时重编码，否则 `-c:v copy`；音频流仅在 replace/mix/addTrack 时编码 aac（与现配音导出参数一致），`keep` 时 copy。因此 soft+replace 依旧秒级完成。
- 容器约束：`soft` 或 `addTrack` → 强制 `.mkv`（沿用现状语义）。
- `subtitleMerger.ts` 的命令构建逻辑迁入 builder，`startMerge` IPC 内部改调 compose 队列；不保留第二份烧录实现。

**回归保障**：对「无音轨、纯烧录/软封」作业，新构建器输出与旧实现的 args 做等价断言单测，保证既有行为逐参数不变。

### D3. 作业队列：单队列单编码槽

`composeQueue.ts`：FIFO，全局 1 个执行槽，作业状态 `queued | running | done | error | cancelled`。

- **为什么不区分轻重作业并行**：softmux/copy 类作业秒级，排队无感；区分两类槽增加状态面而收益趋零。未来 P2 若需要可提升槽数（重编码作业受 CPU/GPU 限制，1 槽也是合理默认）。
- IPC 兼容：`subtitleMerge:startMerge` 签名不变，内部 enqueue 并返回 jobId；进度事件增量携带 jobId（既有渲染层监听不受影响）；`cancelMerge` 支持取消运行中与排队中作业。
- 并发来源：合成工作台 + 配音导出（改道后）可能同时提交，排队提示在两处 UI 呈现。

### D4. 配音导出改道 compose

`exportDubbing` 的视频类形态（replaceTrack/mixTrack/addTrack）改为组装 compose 作业（音轨 = 会话拼接产物 wav，字幕 = none），ducking 参数随 `mix` 传递；`audioOnly` 保持原路径（无视频封装成分）。行为对用户等价，执行体收敛。

### D5. 「顺延字幕优先」在 P1 的落点：导出后衔接入口

自动在合成时替换顺延字幕，需要流水线的产物依赖追踪（P2）。P1 以衔接入口实现该语义：配音视频形态导出成功后提供「去合成」动作，跳转合成工作台并预填产出视频 + 字幕（存在顺延版 `.dubbed.srt` 时优先预填顺延版，否则原字幕）。同时补掉探索发现的断点（配音完成无烧录通路）。

### D6. 合成工作台音轨输入：可选、缺省不变

文件选择区新增可选「配音音轨」输入；选中后输出行动条出现音轨模式控件（替换/混音/双轨，默认**替换**——产品决策）；不选音轨时界面与合成行为与现状完全一致（等价断言覆盖）。

## Risks / Trade-offs

- [矩阵组合爆炸导致命令构建出错] → 纯函数构建器 + 参数化单测覆盖全部合法组合；非法组合（如无视频）在类型与入口层拒绝。
- [烧录代码迁移引入回归] → 无音轨作业与旧实现 args 等价断言；真机冒烟含硬件回退路径。
- [会话目录无上限膨胀] → 删除 workItem 联动清理 + 「清空全部工作项」联动；容量上限/LRU 留待观察（session.json 记录体积便于将来实现）。
- [恢复语义与校对重写交付物冲突（hash 变化频繁）] → 明确"字幕已变，需重建会话"提示；增量失效（仅重合成变更行）留给 P3 闸门场景再做。
- [双入口并发提交排队让用户困惑] → 两处 UI 显示队列位置与来源名称；单槽保证行为可预期。
- [ffmpeg 单遍命令在个别容器/编码组合上的兼容性] → 冒烟覆盖 mp4/mkv × 硬烧/软封 × 三种音轨模式；失败时错误信息带完整命令日志（沿用既有日志要求）。

## Migration Plan

1. 先落 builder + 单测（不接线，零风险合入）。
2. 队列 + IPC 改道（`startMerge` 行为等价，渲染层无感）。
3. 配音导出改道 compose。
4. 会话持久化（新目录结构，无存量数据迁移——旧 tmp 会话本就即焚；workItem 增量字段向后兼容，旧 dubbing 工作项无 sessionId 时按现状"路径预填重建"降级）。
5. 两处 UI（音轨输入、恢复交互、衔接入口）+ i18n。

回滚策略：各步独立可回滚；IPC 签名与事件形制不变，渲染层与主进程可分别回退。

## Open Questions

- 编码槽是否放开 >1（视硬件回退与温控实测数据，P2 前决定即可）。
- 会话目录容量策略（上限/LRU）是否需要在 P2 批量配音前提前做。

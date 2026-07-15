# Design: 流水线核心（P2）

## Context

- P1 已交付：配音会话持久化（headless 可恢复）、统一合成引擎与 FIFO 队列（字幕×音轨单遍矩阵）、后台续跑/重连语义。
- 既有任务系统（`taskProcessor` → `processFile`）已具备：文件级并发调度（maxConcurrentTasks）、暂停/取消（AbortSignal + taskContext）、事件四通道与 workItem 镜像持久化、失败重试可重入。任务类型是三值枚举（字幕生产段），阶段状态以约定字段名（`extractAudio` 等字符串状态机）挂在 IFiles 上。
- 配音管线（`dubbingProcessor`）与合成队列（`composeQueue`）均可无 UI 驱动（P1 验证过）。
- 产品决策（探索定稿）：小白优先、目标驱动创建、配译文、合成默认「替换音轨+烧录译文/顺延字幕」、全自动无闸门（闸门 P3）。

## Goals / Non-Goals

**Goals:**

- 批量配音、批量合成成为任务的可选附加阶段，与听写/翻译同队列、同语义（并发/暂停/取消/重试/持久化）。
- 「视频 → 字幕 → 翻译 → 配音 → 成片」一条龙全自动跑通，批量文件各自独立流动。
- 目标驱动的新建任务向导（勾产物推导阶段），任务级配置快照。
- 每一步不破坏既有行为：不带附加阶段的任务与现状完全一致。

**Non-Goals:**

- 人工闸门与工作台检查员模式（P3）。
- 配方保存、启动台全面改版、旧三类任务页收敛（P4）。
- 字幕输入的视频智能配对（字幕输入任务不可选合成目标）。
- StagePlan/流水线编排引擎的全新抽象（见 D1）。

## Decisions

### D1. 附加阶段挂接既有执行体，不新建编排引擎

`taskType` 三值枚举继续承担字幕生产段；`dub` / `compose` 作为 `formData` 的可选附加段，由 `processFile` 在既有流程尾部顺序执行。

- **为什么不做 StagePlan/PipelineEngine 全新抽象**（探索期方案）：`processFile` 的横切逻辑（简繁归一、标点剥离、sidecar、格式转换、noSave 清理）与阶段强耦合，重写进独立执行体的回归面远大于收益；而附加段方案让事件通道、镜像持久化、调度、暂停/取消、重试全部零成本复用。四阶段的合法顺序唯一（线性），"计划"信息用两个可选配置对象即可表达。若未来出现第五阶段或非线性需求，届时再抽象（届时已有三个阶段执行体的真实样本）。
- 阶段状态沿用字段名约定：`dubbing` / `composeVideo`（`''|loading|done|error` + `Progress`/`Error` 后缀），`STAGE_KEYS` 三处清单（workItemStore/workItemMigration/stageUtils）同步扩展。

### D2. 配音阶段执行体（pipeline/dubStage）

- **文本源 = 纯译文优先**：带翻译的任务取纯译文（`tempTranslatedSrtFile`；仅有双语交付物时经校对 sidecar 的 target 列重建纯译文临时 srt），否则取源字幕。绝不把双语字幕喂给 TTS（同一行会朗读两遍）。
- **执行**：per 文件创建 headless 配音会话（`createDubbingSession` + `runDubbingBatch`），`file.dubbingSessionId` 记录会话（重试续跑已完成行、P3 闸门与工作台回开复用）；产物为**配音轨 wav + 可选顺延字幕**——从 `exportDubbing` 抽出 `buildDubTrack(session, config)`（规划 + 拼接 + 多轨混流，不做视频封装），视频封装统一交给 compose 阶段。
- **配置**（`formData.dub`）：引擎/音色/整体语速/克隆质量/本地并行路数/过长兜底（truncate 默认）/重叠模式——与工作台 `DubbingConfig` 同构，向导默认值取工作台记忆配置。
- **全自动兜底**：overlong 行不等待人工，按 overflow 配置在拼接期截断/顺延（P1 既有语义）；行失败不中断批量，批量结束仍有失败行 → 阶段 `error`（重试仅跑失败行，已完成行经会话持久化跳过），不进入 compose。
- **跨文件互斥**：dub 阶段过全局互斥闸（`transcribeGate` 的 GroupMutex 形制，组名 `dubStage`）——本地 TTS 进程池与云端配额都不适合多文件并发；排队文件的听写/翻译照常并行（阶段流水线既有模式）。行级并发仍由引擎配置决定。

### D3. 合成阶段执行体（pipeline/composeStage）

- **矩阵推导**（`formData.compose`）：
  - 有配音产物 → `audio=replace(配音轨)`，字幕默认 `hard`（顺延字幕存在则优先烧顺延版，否则烧交付字幕：译文优先）；
  - 无配音 → `audio=keep`，字幕按配置 `hard|soft`；
  - 配置面：`subtitle: 'hard'|'soft'|'none'`（默认 hard）+ 烧录样式沿用全局默认样式与合成偏好（画质/编码方式）；P2 不在向导内做样式编辑（提示可在合成工作台调样式预设）。
- **执行**：组装 `ComposeConfig` 入全局队列（新来源 `'pipeline'`），等待 done；进度事件（含 jobId 过滤）转发为 `composeVideo` 阶段进度；输出 `<原名>-final.<ext>`（防覆盖递增，双轨/软封自动 mkv）。全局单编码槽天然串行化批量合成。
- **取消**：任务取消信号 → `cancelComposeJob(jobId)`；暂停不中断已入队作业（与暂停不中断当前文件的既有语义一致）。

### D4. 任务级配置快照

`handleTask` 提交时把完整 `formData`（含 dub/compose）写入 `workItem.configSnapshot`；文件重试从快照读取，不再回读全局 `userConfig`。向导页自持表单状态（不写全局 userConfig），旧任务页行为不变。

### D5. 向导交互（目标驱动，一屏）

`/tasks/new`：① 文件区（拖放/选择，自动识别媒体/字幕，混合输入按多数类型并提示剔除）→ ② 目标产物勾选：`字幕`（媒体输入恒选）、`翻译字幕`、`配音`、`成品视频`（字幕输入禁用）→ ③ 阶段芯片行（听写→翻译→配音→合成按勾选亮起，点击芯片就地 popover 配置，常用项外露）→ ④ 开始（校验就绪性：模型/翻译服务/TTS 引擎，未就绪内联引导跳配置页）。开始即 `saveTaskProject`（含快照）+ `handleTask` + 跳转对应任务详情页。

- 目标→阶段推导：翻译✓→translate；配音✓→dub；成品视频✓→compose；媒体输入且任一下游需要字幕→transcribe。映射为 `taskType`（generateOnly/generateAndTranslate/translateOnly）+ `dub?` + `compose?`。
- 启动台新增「视频 → 配音成片」卡片（featured），直达向导并预勾全部目标；全面改版留 P4。

### D6. 任务详情轨道扩展

`stageUtils.getFileStages` 按任务快照的附加阶段追加「配音」「合成」列；行级重试按钮对 dub/compose 阶段生效（从失败阶段续跑，上游产物直接复用）；`CompletionBanner` 对含 compose 的任务提供「打开成品」入口。旧任务（无附加阶段）渲染与现状一致。

## Risks / Trade-offs

- [processFile 变长（尾部追加两阶段）加剧函数复杂度] → dub/compose 执行体独立成 `main/helpers/pipeline/` 模块，processFile 只做条件调用与错误打点（各 ~20 行接线）。
- [双语交付物重建纯译文出错] → 优先消费纯译文中间产物；sidecar 重建路径有单测覆盖（cue 对齐、空行、时间轴透传）。
- [dub 互斥闸导致大批量排队时长不可见] → 排队文件的 dubbing 阶段显示 loading+0%，日志记录排队原因；限流放开（>1 并发）留待内存实测后决定。
- [向导与旧任务页并存的入口混乱] → P2 只加一张启动台卡片，导航不变；P4 统一收敛为配方。
- [全自动烧录用全局默认样式可能不合用户预期] → 向导合成芯片明示「样式沿用合成工作台预设」并提供跳转；成品不满意可用工作台重烧（产物防覆盖）。
- [批量配音的云端计费风险（无闸门）] → 向导配音芯片展示字符量预估与计费提示（复用工作台预估口径）；P3 闸门提供确认点。

## Migration Plan

1. 类型与阶段字段（纯扩展，零行为变化）。
2. dub/compose 执行体 + 单测（独立模块，不接线）。
3. processFile 接线 + STAGE_KEYS 扩展 + 快照落库（无附加阶段路径回归验证）。
4. 渲染层轨道扩展 → 向导页 → 启动台卡片 + i18n。
5. 回滚：各步独立；未使用附加阶段时新代码不参与执行。

## Open Questions

- dub 阶段互斥是否放开为可配并发（本地多进程池内存代价 vs 吞吐，待真机数据）。
- 成品命名是否需要模板化（暂固定 `-final` 后缀，防覆盖递增）。

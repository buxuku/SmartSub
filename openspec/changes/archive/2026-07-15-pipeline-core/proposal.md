# Proposal: 流水线核心（P2）——批量配音/合成任务化与一条龙全自动

## Why

P1 已备齐地基（配音会话持久化、统一合成引擎与作业队列）。但配音与合成仍是单文件工作台操作，批量任务只覆盖「听写→翻译」两段：用户要产出「配音成片」必须逐文件手动穿针引线三次。产品方向（已定稿）要求把主流水线补全为「听写→翻译→配音→合成」可组合子集、批量执行、全自动跑通——本 change 落地流水线核心执行体与目标驱动的新建任务入口（人工闸门留 P3，配方与启动台改版留 P4）。

## What Changes

- **任务附加阶段模型**：任务配置在既有三类 `taskType`（字幕生产段）之上新增可选附加阶段 `dub`（配音）与 `compose`（合成成片），配置随任务落 `workItem.configSnapshot`（任务级快照，不再依赖全局单例）；阶段状态沿用既有字段名约定（`dubbing` / `composeVideo` + progress/error），事件镜像与工作项持久化零成本复用。
- **任务级配音阶段（批量配音）**：每文件以 headless 配音会话执行（文本源：纯译文中间产物优先，无翻译则源字幕），sessionId 记录在文件上（重试续跑已完成行、P3 闸门复用）；跨文件配音互斥闸（本地共享 TTS 进程池/云端服务商并发闸）；全自动模式下过长行按配置兜底（截断/顺延），不等待人工。
- **任务级合成阶段（批量合成）**：每文件按矩阵默认（有配音 → 替换音轨 + 硬烧字幕，顺延版字幕优先；无配音 → 仅烧录/软封）组装 compose 作业入全局队列（新来源 `pipeline`），产物 `<名称>-final.<ext>` 防覆盖；样式与画质/编码方式沿用合成偏好。
- **新建任务向导**：目标驱动的一屏创建页——拖入文件自动识别，勾选目标产物（字幕/翻译字幕/配音/成品视频）推导阶段链，阶段芯片就地配置（转写引擎/语言/翻译服务/配音引擎音色/合成方式），开始即建任务并跳转任务详情；输入为字幕时合成目标不可选（无视频，配对留后续）。
- **任务详情轨道扩展**：既有任务页按任务的附加阶段动态渲染「配音」「合成」轨道列（状态/进度/错误/重试），完成横幅对含合成任务提供打开成品入口；暂停/取消/重试语义与既有阶段一致（取消联动会话 abort 与合成作业取消）。
- **启动台入口**：新增「视频 → 配音成片」卡片直达向导预设（完整改版留 P4）。

不包含（后续 change）：人工闸门与工作台"检查员模式"（P3）、配方保存与启动台改版、字幕输入的视频智能配对、旧三类任务页收敛（P4）。

## Capabilities

### New Capabilities

- `pipeline-dub-stage`: 任务级配音阶段——附加阶段配置与状态字段、文本源选择、headless 会话执行与 sessionId 关联、跨文件互斥、全自动过长兜底、失败重试续跑、取消/暂停语义。
- `pipeline-compose-stage`: 任务级合成阶段——矩阵默认推导（配音→替换+硬烧顺延字幕优先）、产物命名、compose 队列衔接（pipeline 来源）、状态字段与重试、取消语义。
- `pipeline-task-wizard`: 新建任务向导——文件识别、目标产物勾选→阶段链推导、输入类型约束、阶段配置与任务级配置快照、创建跳转与启动台入口。

### Modified Capabilities

（无——任务系统与任务页无既有 spec 能力；渲染层轨道扩展的要求并入上述三个新能力。）

## Impact

- **主进程**：`main/helpers/fileProcessor.ts`（追加 dub/compose 阶段执行）、新增 `main/helpers/pipeline/`（dubStage/composeStage 执行体与互斥闸）、`taskManager.ts`/`workItemStore.ts`（STAGE_KEYS 扩展、configSnapshot 任务级合并）、`compose/composeQueue.ts`（`pipeline` 作业来源）、`dubbing/dubbingProcessor.ts`（headless 驱动复用，无行为变更预期）。
- **渲染层**：新增 `pages/[locale]/tasks/new.tsx`（向导）+ `components/tasks/wizard/`；`components/tasks/stageUtils.ts`/`TaskRowList`/`TaskGridList`/`CompletionBanner`（轨道列与产物入口）；`home.tsx` 启动台卡片；`locales/{zh,en}/tasks.json`、`launchpad.json`。
- **类型**：`types/types.ts`（IFormData.dub/compose、IFiles 阶段字段）、`types/workItem.ts`（configSnapshot 语义）、`types/subtitleMerge.ts`（ComposeJobSource 增 `pipeline`）。
- **兼容性**：不带附加阶段的任务行为与现状完全一致；旧三类任务页与工作台照常可用；workItem 结构向后兼容（新增字段可选）。

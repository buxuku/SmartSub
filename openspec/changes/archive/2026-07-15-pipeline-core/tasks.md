# Tasks: pipeline-core

## 1. 类型与阶段字段（纯扩展，零行为变化）

- [x] 1.1 `types/types.ts`：`IFormData` 增 `dub?: PipelineDubConfig`（与 DubbingConfig 同构 + 文本源自动解析）与 `compose?: PipelineComposeConfig`（`subtitle: 'hard'|'soft'|'none'`）；`IFiles` 增 `dubbing`/`composeVideo` 阶段字段与 `dubbingSessionId`/`dubbedTrackPath`/`shiftedSubtitlePath`/`finalVideoPath`
- [x] 1.2 `types/subtitleMerge.ts`：`ComposeJobSource` 增 `'pipeline'`
- [x] 1.3 STAGE_KEYS 三处同步扩展（`workItemStore.ts`/`workItemMigration.ts`/渲染层 `stageUtils.ts`）：追加 `dubbing`、`composeVideo`（中断标记、状态推导、进度错误后缀约定一并生效）

## 2. 配音阶段执行体（main/helpers/pipeline/dubStage.ts）

- [x] 2.1 文本源解析：纯译文中间产物优先；仅有双语交付物时经校对 sidecar 译文列重建纯译文临时 srt（纯函数 + 单测：cue 对齐/空行/时间轴透传）
- [x] 2.2 `dubbingProcessor` 抽出 `buildDubTrack(session, config, signal)`：规划+拼接+多轨混流产出配音轨 wav 与可选顺延字幕（`exportDubbing` 改为调用它再做封装，行为不变；test:dubbing 回归）
- [x] 2.3 dubStage 执行体：headless 会话（`file.dubbingSessionId` 关联复用，重试续跑已完成行）→ runDubbingBatch（行进度 → `dubbingProgress` 事件）→ buildDubTrack 产物落文件字段；失败行>0 → 阶段 error；taskContext signal → cancelDubbing 联动
- [x] 2.4 跨文件互斥闸（GroupMutex 形制，组 `dubStage`）：排队期间阶段显示等待中；日志记录排队原因

## 3. 合成阶段执行体（main/helpers/pipeline/composeStage.ts）

- [x] 3.1 矩阵推导纯函数 `deriveComposeConfig(file, composeCfg, mergePrefs, style)`：配音轨→replace、顺延字幕优先、hard/soft/none 分支、`-final` 防覆盖命名与 mkv 约束（单测覆盖全部分支）
- [x] 3.2 composeStage 执行体：入队（source=pipeline）→ 按 jobId 过滤进度事件转发 `composeVideoProgress` → done/error/cancelled 映射阶段状态；任务取消 → cancelComposeJob
- [x] 3.3 `composeQueue`：新来源类型接入（快照/事件透传，无行为变更）

## 4. 主流程接线与快照

- [x] 4.1 `fileProcessor.processFile` 尾部接线：字幕段成功后依序执行 dubStage、composeStage（各自条件判断/错误打点约 20 行；无附加阶段路径零变化）
- [x] 4.2 `handleTask`/`taskManager`：完整 formData（含 dub/compose）写入 `workItem.configSnapshot`；重试路径从快照读取配置
- [x] 4.3 回归：无附加阶段任务全流程（转写/翻译/暂停/取消/重试）行为与现状一致；`npx tsc --noEmit` 通过
      ↳ 静态已证：附加阶段代码全部由 `formData.dub/compose` 条件闸守卫，续跑判定仅 hasPipelineStages 时参与；应用内行为回归并入 7.5 人工验证

## 5. 任务详情轨道扩展

- [x] 5.1 `stageUtils.ts`：`getFileStages` 按任务快照附加阶段追加配音/合成列；`canProofread`/`isFileDone` 等判定兼容新列
- [x] 5.2 `TaskRowList`/`TaskGridList`：新列状态/进度/错误渲染，行级重试对 dub/compose 生效（从失败阶段续跑）；行操作增打开成品
- [x] 5.3 `CompletionBanner`：含合成任务提供「打开成品」入口；i18n zh/en（tasks.json）

## 6. 新建任务向导与启动台入口

- [x] 6.1 `pages/[locale]/tasks/new.tsx` + `components/tasks/wizard/`：文件区（拖放/选择/类型识别与混合输入提示）、目标产物勾选 → 阶段芯片推导（白话文案）
- [x] 6.2 阶段芯片配置 popover：听写（引擎/模型/源语言）、翻译（目标语言/服务商）、配音（引擎/音色/语速 + 字符量与计费提示）、合成（输出方式 + 样式沿用说明与跳转）；默认值取各自记忆配置
- [x] 6.3 就绪校验与内联引导（模型/翻译服务/TTS 未就绪 → 警示 + 跳转配置页，开始禁用）；开始 → saveTaskProject（含快照）+ handleTask + 跳转任务详情
- [x] 6.4 启动台「视频 → 配音成片」卡片（featured、支持拖放直达向导预勾全目标）；`launchpad.json` i18n
- [x] 6.5 i18n zh/en 全量 + `check:i18n` 通过

## 7. 验证与冒烟

- [x] 7.1 单测：新增 `yarn test:pipeline`（23 项：文本源优先级/双语不可解/txt 拒绝/sidecar 映射/矩阵推导/命名递增）；test:dubbing 151 / test:compose 31 / test:voice-clone 160 回归全过
- [x] 7.2 静态：tsc（main/renderer 改动文件 0 错误）、prettier、check:i18n、yarn build 完整构建通过
- [x] 7.3 真机冒烟·一条龙：3 个视频「字幕+翻译+配音+成片」全自动跑通，音画字同步、产物齐备、任务列表轨道状态正确
- [x] 7.4 真机冒烟·控制流：中途暂停/取消/单文件重试（含 dub 失败行续跑、compose 排队取消）；切页后台续跑回开重连
- [x] 7.5 真机冒烟·旧路径回归：三类既有任务、配音/合成工作台、最近任务回开均无行为变化

> 2026-07-15 用户真机试用向导创建流程（发现并修复输出内容下拉的 i18n 命名空间缺失）后确认归档；后续问题按增量修复处理。

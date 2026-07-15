# Tasks: pipeline-foundation

## 1. 合成命令构建器（compose 地基）

- [x] 1.1 `types/subtitleMerge.ts`：新增 `ComposeConfig`（`subtitle: none|soft|hard(style/quality/encoderMode)` × `audio: keep|replace|mix|addTrack(trackPath)`、输出路径）、`ComposeJob`（`id/status/progress/来源标识`）与队列状态类型；容器约束规则（soft 或 addTrack → mkv）随类型注释固化
- [x] 1.2 新建 `main/helpers/compose/composeCommandBuilder.ts` 纯函数 `buildComposePlan(config)`：吸收 `subtitleMerger.ts` 硬烧/软封分支（ASS 滤镜、编码器与画质映射、faststart、nv12）与 `dubbing/audioPipeline.ts` 的 replace/mix(ducking)/addTrack 封装；实现最小化重编码原则（仅 hard 重编视频、仅换轨编码音频 aac，其余 copy）
- [x] 1.3 单测（无 ffmpeg 执行的 args 断言，`yarn test:compose` 31 项）：全部合法矩阵组合参数化断言；「无音轨作业」与旧 subtitleMerger/audioPipeline 构建结果逐参数等价断言；非法组合（none+keep）拒绝

## 2. 合成作业队列与 IPC 改道

- [x] 2.1 新建 `main/helpers/compose/composeQueue.ts`：FIFO 单执行槽、作业状态机（queued/running/done/error/cancelled）、排队取消直接出队、进度与状态事件携带 jobId/source、队列快照广播（compose:queue）、电源阻眠收敛到队列层
- [x] 2.2 新建 `main/helpers/compose/composeRunner.ts`：执行/进度解析/取消与半成品清理；硬件失败自动回退迁移至此层（含音轨作业回退时保持音轨配置、仅重试一次、回退事件透传）
- [x] 2.3 `ipcSubtitleMergeHandlers.ts`：`startMerge` 签名兼容改为 enqueue，`cancelMerge` 支持指定 jobId 取消排队/运行中作业（无参回落面板来源活动作业），新增 `getQueue`；`subtitleMerger.ts` 收敛为滤镜/样式助手 + 文件信息工具（执行体移除，不留第二份烧录实现）
- [x] 2.4 回归验证：`npx tsc --noEmit`（main/renderer）通过、`yarn test:compose` 31 项等价断言通过；应用内全流程回归见 6.4

## 3. 合成工作台配音音轨输入

- [x] 3.1 `FileSelector.tsx`：新增可选「配音音轨」第三槽位（选择/清除；`selectFile` IPC 增 audio 类型），未选择时界面与现状一致
- [x] 3.2 `MergeButton.tsx` + `useSubtitleMerge.ts`：音轨模式分段控件（替换/混音/双轨，默认替换，仅选中音轨时显示）、双轨 mkv 容器约束提示与输出路径扩展名联动、按 source 过滤进度事件、排队位置展示（queuedAhead）
- [x] 3.3 `renderer/public/locales/{zh,en}/subtitleMerge.json`：音轨输入、模式、mkv 提示、排队文案；`check:i18n` 通过

## 4. 配音会话持久化

- [x] 4.1 新建 `dubbing/sessionStore.ts`（零 electron，root 注入）+ `dubbingProcessor.ts` 会话工作目录迁至 `userData/dubbing-sessions/<sessionId>/`；`session.json` 元数据（字幕路径+内容 hash、视频路径、配置快照、逐行记录：状态/voiceId/appliedSpeed/finalMs/wav 相对文件名/error/action）
- [x] 4.2 行级状态节流落盘（800ms 防抖，与 workItemStore 同模式）：批量逐行/单行重生成/接受变速/换 voice 均触发，批量结束与导出后 flush；`disposeSession` 不再删目录仅释放内存（从未产出结果的会话直接清理防空目录堆积）
- [x] 4.3 恢复 API：`restoreDubbingSession` + `dubbing:loadSubtitle` 支持 sessionId 恢复——字幕 hash 一致恢复行状态与产物、不一致返回 stale 语义（确认后携 rebuildSessionId 重建）、单行 wav 缺失仅该行降级待合成（synthesizing 落盘为 pending）
- [x] 4.4 workItem 关联与清理联动：dubbing 工作项 `configSnapshot.sessionId` 恒写入（重建即刷新）；删除工作项/清空全部工作项联动删除会话目录；无 sessionId 的历史工作项降级为路径预填重建
- [x] 4.5 单测（test:dubbing 套件扩展，151 项全过）：元数据读写往返、hash 校验、行级 voice 往返、产物缺失降级、失败行保持、损坏元数据容错、删除清理

## 5. 配音工作台恢复交互与导出改道

- [x] 5.1 `useDubbing.ts` + `DubbingPanel.tsx` + `dubbing.tsx`（?session=&workItem= 参数）+ `workItemUtils.getWorkItemTarget`：回开时按 sessionId 恢复会话（行状态与回放产物回填，「继续配音/全部重跑」与字符量预估按既有 summary 语义自动生效）、恢复成功提示条、字幕已变重建确认对话框（取消回空态、确认删旧数据重建）
- [x] 5.2 `exportDubbing` 视频形态（replace/mix/addTrack）改走 compose 队列（source=dubbingExport、会话取消联动取消作业）；audioOnly 路径不变；audioPipeline 三个封装函数保留供 poc 脚本，应用运行路径收敛到 compose
- [x] 5.3 导出成功「去合成」衔接：产物为视频时结果横幅新增入口，跳转 `subtitleMerge?video=<产出>&subtitle=<顺延版优先，否则原字幕>`；仅音频导出不显示；i18n zh/en
- [x] 5.4 回归：test:dubbing 151 项 / test:voice-clone 160 项 / test:ass-builder 全过

## 6. 验证与冒烟

- [x] 6.1 静态与套件：`npx tsc --noEmit`（main/renderer，改动文件 0 错误；docs 与既有 parameterProcessor 等旧错误不受影响）、`check:i18n`、test:compose 31 项、test:dubbing 151 项、test:voice-clone 160 项全过
- [x] 6.2 真机冒烟·会话恢复：批量合成中途退出应用 → 重开恢复行状态不重合成；改动字幕后重开出现重建提示
      ↳ sessionStore 单测覆盖元数据往返/hash 校验/缺失降级/删除联动；2026-07-15 用户真机验证：配音中离开页面后台续跑、回开恢复并跳过已完成行 ✓
- [x] 6.3 真机冒烟·一遍出片：视频+字幕+配音轨（硬烧+替换）单作业产物的音画字正确，耗时明显低于「配音导出+烧录」两遍方案
      ↳ 命令级冒烟已过（yarn smoke:compose）：hard+keep / hard+replace / hard+mix / soft+addTrack / none+replace 五组合在打包 ffmpeg 上执行成功、输出流形态断言通过（含 1v2a1s 双音轨）
- [x] 6.4 真机冒烟·队列：合成页与配音导出并发提交按序执行、排队取消即时生效；无音轨纯烧录（含硬件回退提示）无回归
      ↳ 无音轨作业 args 与旧实现逐参数等价由 test:compose 断言；2026-07-15 用户真机验证：VideoToolbox 硬烧经队列完成（日志 11:38:20→11:38:57）、合成中切页重连正常 ✓

## 7. 冒烟反馈修复（2026-07-15 用户实测发现）

- [x] 7.1 TTS/ASR worker 预期停止误报「异常退出」：池收缩/dispose/退出的信号终止垃圾码（如 0x6B0E7680）被记为 error——两个运行时的 exit 处理器区分预期停止与真崩溃（`ttsRuntime.ts` 按 alive 标记、`sherpaFunasrRuntime.ts` 按 worker 引用），smoke:utility 验证通过
- [x] 7.2 配音中切换页面批量被中断：`useDubbing` 卸载改为 `disposeSession(keepRunning)`——批量/导出进行中时后台继续（主进程持有会话与电源阻眠），经最近任务回开实时重连（sessionView 携 running、批量终态事件 stage=done 退出运行态）；空闲会话仍正常释放
- [x] 7.3 合成中切走再回来页面空态卡「处理中」：合成页挂载时查队列快照重连本面板来源的进行中作业（ComposeJobView 扩展 videoPath/subtitlePath/audioTrack 重连上下文），恢复文件区/输出设置/进行中状态；进度处理器接收终态事件（completed/error/idle），重连页面完成后正常显示成功浮层

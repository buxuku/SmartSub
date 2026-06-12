# 编辑器专业化 · 批次 6「编辑器功能补全」设计

> 来源：UX_ANALYSIS_REPORT §6.3 P1#8（时间轴）、P1#7/#15（失败工作流）、P1#11/#29（批量 AI 不可取消）、§11 v2.18.0 beta.3。
> 用户决策：先做编辑器侧三件（A 时间轴 / B 失败集中处理 / C 批量 AI 取消），合成页四件套留批次 7。

## 现状病灶

- 展开行时间头只是文本，起止时间不可改——字幕工具基本功缺失。
- 失败处理只有「上一条/下一条」两个小按钮；89/91 失败时只能逐条手动跳。
- `BatchAiOptimizeDialog.tsx` 的 `isPaused` 声明未用；关弹窗不中断主进程批量循环。

## 设计

### A. 时间轴行内编辑

- 新组件 `renderer/components/subtitle/TimeRangeEditor.tsx`：
  - 默认显示 `#id · HH:MM:SS,mmm --> HH:MM:SS,mmm` 文本（可点击）。
  - 点击进入编辑态：起/止两个输入框（SRT 时间格式），Enter 确认、Esc 取消、失焦确认。
  - 校验链：格式合法 → 起 < 止 → 起 ≥ 前一行止 → 止 ≤ 后一行起。任何一条不过：输入框红框 + 行内错误文案，不应用。
  - 邻行钳制保证数组按时间有序（播放联动二分索引依赖该不变量）。
- `useStandaloneSubtitles` 新增 `handleTimeChange(index, startSec, endSec): string | null`（返回错误文案或 null）：
  - 校验邻行边界；通过则构造新行（`startEndTime` + `startTimeInSeconds/endTimeInSeconds` 同步更新）。
  - 单行 RangeCommand 入撤销栈（先 flushPendingEdit），`isDirty = true`。
- `SubtitleRow` 展开态时间头替换为 `TimeRangeEditor`。

### B. 失败集中处理模式（P1#15）

失败导航栏从「计数 + 上/下导航」升级为工作流：

- **只看失败开关**：开启后虚拟器数据源换成 `failedIndices` 映射数组；行组件拿到的仍是真实索引，点击/展开/编辑/自动滚动照常。当前行若非失败行，列表中不显示（不影响其展开状态）。
- **处理进度**：开启筛选时快照初始失败数 N0，栏内显示「已处理 (N0 − 当前失败数)/N0」；关闭筛选清空快照。
- **批量重翻**：「重翻失败 (N)」按钮，一键用默认翻译服务商（`userConfig.translateProvider`）重翻全部失败行。
  - 主进程新 IPC `retranslateSubtitles({ batchId, subtitles: [{id, startEndTime, content[]}], sourceLanguage, targetLanguage })`：
    - 校验默认服务商存在；复用 `translateWithProvider` 引擎（与正式任务同链路，支持全部服务商类型）。
    - 逐条结果回调里发 `retranslateProgress` 事件（done/total）；每条边界检查 AbortSignal。
    - 返回 `{ success, cancelled?, data: TranslationResult[] }`（取消时返回已完成部分）。
  - 渲染层：重翻期间失败栏显示「重翻中 i/N + 取消」；完成/取消后按 `id + startEndTime` 匹配回填 `targetContent`，一次 `updateSubtitles` 提交 = 一条撤销命令；匹配不上的行跳过。
  - 重翻期间列表可继续浏览编辑；回填时已被用户改过时间戳/结构的行自然匹配失败被跳过。

### C. 批量 AI 优化可取消（P1#11）

- 主进程 `ipcProofreadHandlers.ts` 增加模块级取消注册表 `Map<string, AbortController>` + IPC `cancelProofreadBatch(batchId)`；B 的重翻与 C 的批量优化共用。
- `batchOptimizeSubtitles` 接受 `batchId`，每批边界检查 signal；取消时跳出循环，返回 `{ success: true, cancelled: true, data: 部分结果 }`。
- `BatchAiOptimizeDialog`：
  - 调用时生成 `batchId`；running 步骤加「取消」按钮；运行中关闭弹窗先发取消。
  - 取消后进 review 步骤显示部分结果，标注「已取消，显示部分结果」。
  - 移除未使用的 `isPaused` 死代码。

## 错误处理

- 时间输入非法只阻断该次确认，不破坏行数据；Esc 恢复原文本。
- 重翻无默认服务商 → toast 引导去资源中心配置；单条翻译失败计入结果但不中断整批（与任务链路语义一致）。
- 取消注册表在 handler finally 中清理，防泄漏。

## 验收

- 改任意行起止时间：合法生效且可撤销，非法被拦截有提示；改完播放联动仍准确。
- 只看失败开启后一屏全是失败行，修复若干条后进度「已处理 x/N0」准确；批量重翻成功回填、可取消、整批可一键撤销。
- 批量 AI 优化运行中可取消，部分结果可审核采纳；关弹窗即停止主进程循环（日志可证）。
- 门禁同批次 1-5：renderer tsc 非测试 0 新增；main tsc 基线不新增；路由冒烟 200；i18n zh/en 同步。

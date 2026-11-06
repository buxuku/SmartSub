## Why

「优先使用内封字幕」从 3.9 起收进了工具栏「字幕格式」气泡的最底部，可见性很低；而它又是默认开启、静默生效的：视频只要带文本字幕轨，开始任务就直接抽第一条，跳过语音识别。对不知情的用户，这意味着两类不好自查的困惑——「为什么没有识别」「为什么字幕的语言 / 断句和我设置的不一样」；而想强制语音识别的用户（issue #419 起）又很难找到这个开关。

直接把开关放回工具栏行不通：工具栏现在是 9 个控件的不换行一行（最小宽度 1024），已经放不下。顺带还有两处历史问题：

- 开关下面的说明文案 `configBar.embeddedSubtitlesTip` 在 zh / en 语言包里根本不存在，回退的中文写的是「封装进视频作为独立可切换字幕轨」——与真实行为（**提取**视频里已有的字幕轨）恰好相反。
- 这是一个只在「视频里确有内封字幕」时才有意义的选项，长期占着一个常驻位置并不划算。

所以这次换一个思路：开关挪进「高级选项」，而在**它真正会生效的那一刻**——点击「开始」且列表里确有内封字幕——问一次，并告诉用户之后在哪里调整。

## What Changes

- **开始任务前探测。** 「生成字幕」「生成并翻译」的开始（任务页、新建任务向导、`?autostart=1` 自动开始）在提交之前，对待处理视频探测是否有可直接提取的文本字幕轨。探测对象只限不是字幕、没有配对字幕、容器可能内封字幕的文件；只要任意一个文件命中就立即弹窗，不等其余文件。
- **探测不让用户感到卡顿。** 与就绪校验并行；最多 4 个文件同时探测；首个命中即中止其余；整体 1 秒预算，超时、出错一律视为「无结果」——不弹窗、不阻塞，任务按原有行为继续（失败开放）；探测子进程隐藏窗口。
- **确认对话框。** 展示命中的文件名与文本字幕轨（语言 · 编码），说明「使用内封字幕」与「改用语音识别」的差异，提示之后可在「高级选项 › 转写」里调整。出口：使用内封字幕 / 改用语音识别 / 取消（取消与 Esc 都终止这次开始）。选择只对本次提交生效，对列表里所有带内封字幕的视频一视同仁。
- **记住我的选择，不再提示。** 复选框默认不勾；勾选后点任一选择，同时关闭「开始前提示」（`settings.embeddedSubtitlePrompt = false`）并把所选值写为 `useEmbeddedSubtitles` 的默认值（只写这一个键）。点「取消」不记住。
- **高级选项。** 「优先使用内封字幕」开关从「字幕格式」气泡移到「高级选项 › 转写」顶部（任务页与向导共用同一个组件），其下新增「开始前提示我选择」选项（即时生效；开关关闭时置灰），可随时把提示重新打开。同时用准确的文案（「视频自带文本字幕轨时直接提取，跳过语音识别」）取代缺失的 `embeddedSubtitlesTip`，并把中文标签从「优先内封字幕」改为「优先使用内封字幕」，读起来是一个明确的动作。
- **不弹窗的情形。** `useEmbeddedSubtitles` 显式为 `false`、「开始前提示」已关闭、重试（沿用快照）、配置已固定的任务（任务页以只读快照展示，主进程每次开始都沿用已存的快照，新选择不会被采纳）、翻译字幕类任务、自动化 / CLI / MCP 以及在线下载的自动衔接。
- 新增内部 IPC `findEmbeddedSubtitles`（仅界面使用，不进自动化目录）；任务数据模型不变，不新增任务字段。
- 测试：探测调度（并发、早退、预算、中止、失败开放）、真实 ffmpeg 的探测与中止、提交流程（弹窗 / 各出口 / 记住 / 不弹窗的各种情形）、高级选项里的控件、工具栏气泡不再含该开关。
- 不做：按字幕语言挑选轨道（仍取第一条文本轨）、添加文件时预探测并在行上打徽标（可作第二阶段）、「高级选项」按钮上的强制识别指示点、自动化 / CLI 的同类询问、版本号与 `Changelog/`（发版时写）。

## Capabilities

### New Capabilities

- `embedded-subtitle-prompt`: 开始任务前探测内封文本字幕并询问是否使用——探测范围与不卡顿保证、确认对话框与三个出口、「记住我的选择」的写入范围、不弹窗的情形，以及「高级选项」里的开关与提示选项。

### Modified Capabilities

（无。已有规格里没有「优先使用内封字幕」的界面要求；`task-defaults-memory`（`sync-task-defaults-on-edit` 引入，尚未归档）的「向导与开始任务不写默认配置」在本变更里有一处有意的、范围限于单个键的例外，已在该规格的对应要求末尾注明，并在本变更的规格与设计里写明。）

## Impact

- 共用类型：`types/embeddedSubtitle.ts`（新增：探测请求 / 结果）。
- 主进程：`main/helpers/embeddedSubtitleProbe.ts`（新增，从 `audioProcessor.ts` 搬出 `probeEmbeddedSubtitles`，增加可中止与 `windowsHide`；`audioProcessor.ts` 原样再导出，调用方不变）、`main/helpers/embeddedSubtitleScan.ts`（新增，探测调度，纯逻辑、可注入探测函数）、`main/helpers/ipcEmbeddedSubtitleHandlers.ts`（新增，`findEmbeddedSubtitles`）、`main/background.ts`（注册）、`main/helpers/store/types.ts`（`settings.embeddedSubtitlePrompt`）。
- 渲染进程：`renderer/lib/embeddedSubtitleScan.ts`（新增，开始前探测与失败开放）、`renderer/hooks/useEmbeddedSubtitlePrompt.tsx`（新增，对话框与出口）、`renderer/hooks/useTaskSubmission.ts`（并行探测、校验后询问、改写本次提交；重试可关闭）、`renderer/components/TaskControls.tsx`（`promptEmbeddedSubtitles` 入参）、`renderer/pages/[locale]/tasks/[type].tsx`（重试与固定快照页关闭询问）、`renderer/components/tasks/EmbeddedSubtitleControl.tsx`（新增）、`renderer/components/tasks/AdvancedSheet.tsx`、`renderer/components/tasks/OutputFormatControl.tsx`（移除开关）、`renderer/public/locales/{zh,en}/{home,tasks}.json`。
- 测试与脚本：`scripts/test-embedded-subtitle-scan.cjs`（新增，已加入 `test:pro-baseline`）、`scripts/test-task-submission-ui.tsx`、`renderer/hooks/__tests__/useTaskSubmissionEmbeddedPrompt.test.tsx`（新增）、`renderer/lib/__tests__/EmbeddedSubtitleScan.test.ts`（新增）、`renderer/components/__tests__/EmbeddedSubtitleControl.test.tsx`（新增）、`renderer/components/__tests__/AdvancedSheetEmbeddedSubtitles.test.tsx`（新增）、`renderer/components/__tests__/OutputFormatControl.test.tsx`。
- 对外行为：带内封文本字幕的视频在点「开始」时会问一次（可勾选不再提示）；其余情形的开始流程不变，没有内封字幕的列表不会多出任何提示。无新依赖；存储结构不变（`settings` 新增一个可选布尔键，缺省等于「提示」）；任务快照、配方与自动化的 schema 不变（`useEmbeddedSubtitles` 仍是同一个任务级布尔）。
- 已知限制：
  - 超出 1 秒预算（慢速网络盘、休眠中的机械盘、杀毒软件拖慢进程启动）时放弃探测、不弹窗，行为等同改动之前：开关开启则静默使用内封字幕。
  - 选择按整个任务生效（`useEmbeddedSubtitles` 是任务级）；混合列表里没有字幕轨的文件无论如何走语音识别。
  - 有多条文本字幕轨时仍取第一条，不看语言；对话框列出全部轨道，让用户知情。按语言选轨需要单独的改动。
  - 因为命中即停，对话框只描述第一个命中的文件，不统计「共有几个文件带字幕」。

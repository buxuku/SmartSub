## Why

issue #537：用户在配音工作台加载任务输出的「原文 + 译文」双语字幕，只想配译文，结果整份双语都被朗读了——同一行里原文和译文一个接一个念。

根因在工作台这条入口：`createDubbingSession` 把每条字幕行的换行压成空格后整行交给 TTS，不区分语言。流水线的配音阶段没有这个问题——它优先取纯译文，只有双语交付物时才用校对 sidecar 的译文列重建纯译文（`pipeline-dub-stage` 的「配音文本源为纯译文优先」要求，明文禁止把双语字幕直接送入合成）。工作台没有对应的约束，而用户在这里最常载入的恰好就是任务交付的双语字幕。

## What Changes

- 工作台载入的字幕被校对 sidecar 登记为任务的双语交付物（「原文在前」或「译文在前」）时，**每一行只念译文行**：由 sidecar 判断这是不是双语交付物、语言顺序是什么，再用 sidecar 记录的译文（对不上时用原文）在该行里定位译文块。念的文字仍取自所载文件本身，所以手工改过的字幕照常工作。
- 定位不到译文的行保持原行为（整行念）并写警告日志，不阻断会话创建；纯译文、源语言字幕、没有 sidecar 的外部字幕行为不变。
- 译文行被定位到时，配音语言取 sidecar 的目标语言，并按实际要念的文本检测语言，而不是按双语整体。
- 导出的顺延字幕（`aligned.srt`，合成阶段烧进成片的那份）**仍保持双语**：会话行记录双语版面（`display`），导出时未编辑的行原样还原，编辑过的行只替换译文行。
- sidecar 的归属判定从 `sourceFile / targetFile / finalTargetFile` 扩大到任务写出的全部字幕（第二交付格式、合成阶段保留的带时间轴副本），这些文件载入工作台时同样能认出 sidecar。
- 不做：没有 sidecar 的外部双语字幕（无从知道哪一行是译文，见 design）；界面提示；已保存旧会话的迁移；流水线本身（它已是纯译文优先）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `dubbing-workbench`: 新增两项要求——双语交付字幕只念译文行、导出的顺延字幕保留双语。
- `dubbing-session-persistence`: 新增一项要求——双语行的展示版面（`display`）随会话落盘与恢复；没有该字段的旧会话照常加载。

## Impact

- 主进程：`main/helpers/dubbing/bilingualScript.ts`（新增：交付物判定、译文定位、展示文本还原）、`dubbingProcessor.ts`（`createDubbingSession`、`toSessionMeta`、`restoreDubbingSession`、`exportDubbing`）、`speakerMetadata.ts`（归属范围、对齐规则抽成 `alignSidecarCues`、可传入调用方已有的 sidecar 查找结果）。
- 类型：`types/dubbing.ts`（`BilingualCueDisplay`、`PersistedDubbingCue.display`）。
- 对外行为：载入双语交付字幕后，工作台的行文本、字符量预估、检测语言、试听与导出的音频都只含译文；`session.json` 里双语行多一个可选的 `display` 字段。
- 归属范围扩大的副作用：第二交付格式与带时间轴副本现在也能拿到 sidecar 的说话人信息与目标语言，与同一份交付物的 `.srt` 一致。
- 无新依赖、无数据迁移；不是双语交付物的字幕（纯译文、源字幕、无 sidecar 的外部字幕），会话内容、`session.json` 与既有行为逐项不变。
- 已知限制：本修复之前创建的会话（旧 `session.json`）保持当时保存的行文本；没有 sidecar 的外部双语字幕仍整行念。

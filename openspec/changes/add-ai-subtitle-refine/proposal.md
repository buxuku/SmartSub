# AI 字幕精修（LLM 语义断句 + 字幕校正）

## Why

规则断句只认标点、停顿和宽度，无法理解语义：连接词吊在行尾（「…问题就是」）、犹豫停顿把数字劈成两半（「花了三｜十五天」）、口头语切成碎片条——这些是调参永远修不掉的一类问题，也是与竞品（卡卡字幕助手以「LLM 智能断句 + 校正」立身）在字幕可读性上的核心心智差距。用户已在 #175（逐词识别 + 大模型重新组句）、#110（断句粒度控制）直接提出诉求。词级时间戳管线（builtin token 路径、faster-whisper `word_timestamps`、云端听写词级路径）与 AI 服务商框架（结构化输出、回显锚定、批量并发、失败修复）均已就绪，只缺语义编排层，边际成本低。

## What Changes

- 新增可选的「AI 字幕精修」管线阶段，位于转写完成之后、翻译之前，内部两遍串行：
  - **遍 A · AI 语义断句**：在词级时间轴上重构字幕条边界。LLM 按「原文逐字不变、只插 `<br>` 断点标记」协议输出，经等值 + 限长校验（不过则带 diff 反馈重试，上限 2 轮），再按规范化字符 offset 精确映射回词序列，取首/末词真实时间戳成句。
  - **遍 B · AI 字幕校正**：在已定型的字幕条内批量修正文本（同音字/错字、语气词、大小写、标点、公式与代码格式），不动时间轴与条数。带回显锚定防合并/滑移，注入术语表，支持低置信词标注（whisper token 概率）。
- 转写引擎在产出字幕的同时向管线传出词级时间轴中间产物；无词级输出的引擎（FunASR / Qwen3-ASR / FireRedASR / CLI）降级为「近似模式」——LLM 在字幕条文本上重组，时间由条边界 + 比例插值推导。
- LLM 结果之后仍过现有物理护栏纯函数（宽度硬切回溯、短碎片合并、最短显示时长），语义与物理分离；LLM 不可用或校验重试耗尽时整体回退规则断句，任务不失败、只降级并记日志。
- 配置面：任务级「字幕断句方式」新增「AI 语义断句」档；「AI 字幕校正」为独立开关；服务商复用现有 AI 翻译服务商配置；两者默认关闭，Recipe / 配置快照自动承载。
- 校对台既有「AI 润色」（transcript 校对模式）与遍 B 收敛到同一个主进程校正服务，避免两套 prompt 与批处理逻辑漂移；校对台的交互与行为保持不变。

## Capabilities

### New Capabilities

- `ai-subtitle-segmentation`: AI 语义断句——词级时间轴输入分档（精确/近似）、verbatim `<br>` 断句协议与校验反馈循环、offset 精确对齐、按语音段边界分窗与并发、物理护栏后处理、失败降级规则断句。
- `ai-subtitle-correction`: AI 字幕校正——条内文本批量校正协议（id→text + 回显锚定）、术语表与低置信词注入、条数与时间轴不变性保证、与校对台 AI 润色共享服务、失败保留原文。

### Modified Capabilities

（无——现有能力的需求不变：`builtin-subtitle-timeline` 等转写能力仍按原规范产出规则断句结果作为本阶段输入与降级兜底；校对台 AI 润色行为不变，服务化属实现细节。）

## Impact

- **主进程**：`main/helpers/fileProcessor.ts` 新增精修阶段编排；`main/helpers/engines/*` 传出词级时间轴（builtin / faster-whisper / cloudAsr 已有数据，仅需保留传递）；新模块 `main/helpers/subtitleRefine/`（断句协议编解码、校验器、offset 对齐、分窗，均为纯函数）；`main/helpers/ipcProofreadHandlers.ts` 的 `batchOptimizeSubtitles` 抽取为共享校正服务。
- **复用基建**：AI 服务商配置与客户端、`batchConcurrency`、思考模式控制、术语表注入、回显锚定模式（对齐 `main/translate/services/ai.ts` 的 D4/D7/D8 设计）。
- **渲染层**：任务向导与设置页新增断句档位与校正开关；Recipe / configSnapshot 扩展；i18n（zh / en）新增文案。
- **测试**：新增 `test:refine` 纯函数测试脚本（协议解析、校验反馈、offset 对齐、近似模式插值），沿用现有 `tsc && node` 测试模式。
- **成本与依赖**：无新第三方依赖；开启后遍 A / 遍 B 各消耗约 2× 全文 token（回显所致），走 Ollama 本地模型可完全免费。

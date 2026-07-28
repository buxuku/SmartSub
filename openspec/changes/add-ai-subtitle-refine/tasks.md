# Tasks · AI 字幕精修

## 1. 纯函数核心（`main/helpers/subtitleRefine/`）

- [x] 1.1 建立模块骨架与类型：`RefineInput`（规则 cues + 词级序列 + Tier 标记）、`RefineOptions`（限长/服务商/开关），零 electron 依赖
- [x] 1.2 断句协议编解码：窗口文本拼装（含 CJK/拉丁空格策略）与 `<br>` 输出解析
- [x] 1.3 校验器：规范化等值比对 + 差异定位（生成回喂 LLM 的错误描述）+ 逐段限长（CJK 字数 / 拉丁词数，随任务断句设置派生）
- [x] 1.4 精确对齐：规范化字符 offset → 词索引映射表，断点换算词边界，产出真实词级时间戳 cues（D4）
- [x] 1.5 近似模式对齐：cue 文本重组，边界命中沿用原条时间、条内比例插值（复用 `resplitSubtitleCues` 插值逻辑，D6 Tier 2）
- [x] 1.6 分窗：按 VAD/能量语音段间隙切窗（目标 300–500 词），无语音段数据时取最大词间隔（D5）
- [x] 1.7 护栏编排：LLM 结果依次过 `mergeShortCues`、宽度/时长硬上限回溯切分、`enforceMinDisplayDuration`（D8）
- [x] 1.8 新增 `test:refine` 测试脚本（协议解析、校验反馈、offset 对齐、近似插值、分窗边界），注册进 package.json

## 2. 词级时间轴传出（引擎侧，D6）

- [x] 2.1 builtin 引擎：成句前的 `TokenTriple[]`（含 token 概率 p）随转写结果传出，落盘工作目录 sidecar `<media>.words.json`
- [x] 2.2 faster-whisper 引擎：`segments[].words` 三元组传出 + sidecar，同 2.1 结构
- [x] 2.3 云端听写：词级路径服务商传出词序列；无词级返回的服务商标记 Tier 2
- [x] 2.4 sherpa 系 / 本地 CLI 引擎：标记 Tier 2，确认规则 cues 可作为近似模式输入（不落盘 sidecar 即近似模式，无需代码）
- [x] 2.5 任务重试续跑：sidecar 路径随 `file.wordTimelineFile` 持久化；resume 复用转写产物时精修结果（已写入 srt）一并复用，常规重试则随转写重跑精修

## 3. 断句遍编排（遍 A）

- [x] 3.1 LLM 请求器：复用 AI 服务商配置与客户端（OpenAI 兼容/Ollama 等），生成参数沿用服务层默认（温度 0.3 + provider 自定义参数可覆盖），思考模式在服务层按 provider 自动生效
- [x] 3.2 断句 prompt（中英 few-shot + 限长变量）+ 校验失败反馈重试循环（单窗 ≤2 轮，D3；translator 单轮接口用「嵌入上一次输出」模拟多轮）
- [x] 3.3 窗口并发与速率：`resolveBatchConcurrency` + provider requestInterval 起始限速；AbortSignal 在窗口边界/请求内响应取消；单窗失败仅该窗降级
- [x] 3.4 阶段整体降级：配置错误/全部窗口失败时保留规则断句，任务不失败；日志记录降级原因与窗口失败率

## 4. 校正遍（遍 B，D7）

- [x] 4.1 从 `ipcProofreadHandlers.batchOptimizeSubtitles` 抽取共享校正服务（批处理/重试/取消），校对台 AI 润色改调共享服务且行为不变（`subtitleCorrectionService.ts`，legacyMap 协议逐字保持既有格式）
- [x] 4.2 增强：回显锚定（provider 级开关，检测合并/滑移）+ 结构化输出 schema + 错位批次整批重试，失败批保留原文（anchored 协议，复用翻译框架解析/校验）
- [x] 4.3 术语表命中注入 prompt；Tier 1 下低置信词（p < 阈值 0.5，内部常量）作为疑似错误列表注入
- [x] 4.4 管线调用点：断句定型后、简繁转换/中文去标点之前执行；条数与时间戳不变性断言

## 5. 管线编排与阶段状态

- [x] 5.1 `fileProcessor` 插入精修阶段调用点（转写后、翻译前），按任务配置判定执行遍 A/遍 B（D1、D9 次序）
- [x] 5.2 新增 `refineSubtitle` 阶段状态与进度（窗口/批次完成数合成），接入 `taskFileChange` 事件双写与取消/重试语义（D10）
- [x] 5.3 任务页阶段格子渲染：进行中/完成/错误 + 进度（stageUtils 数据驱动，`stage.refine`）；旧 WorkItem 无该阶段时不渲染

## 6. 配置与 UI

- [x] 6.1 配置字段：断句方式扩展「AI 语义断句」档（UI 四态，存储为独立 `aiSegmentation` 布尔保证旧快照兼容）、`aiCorrection` 独立开关、`refineProvider` 字段（默认「跟随翻译服务」，任务启动时解析并记日志）（D9）
- [x] 6.2 任务向导 UI：断句档位扩展（AdvancedSheet 四态）+ AI 精修配置区（服务商下拉首项「跟随翻译服务（当前：X）」+ 显式选项、校正开关、Tier 2 近似提示）；向导 blockers 即时校验（跟随不可解析/显式服务商失效时阻断开始）
- [x] 6.3 Recipe / configSnapshot 承载（formData 自动携带新字段）+ 任务页 SnapshotConfigBar 精修摘要条目
- [x] 6.4 i18n：zh / en 全部新增文案，`check:i18n` 通过

## 7. 验证与文档

- [x] 7.1 端到端手测：中文无标点长语流、犹豫劈开数字、英文 dangling article 三类样例 × 词级/近似两档 × 降级路径（断网、无效密钥、弱模型改写原文）——已人工手测通过（2026-07-28）

## 8. 体验优化（评审追加）

- [x] 8.1 精修配置外化到任务工具栏：新增 `AiRefineControl` 挂入 `InlineConfigBar`（向导「自定义任务流」与旧任务页两个入口同时覆盖），转写类任务展示
- [x] 8.2 小白友好交互：工具栏按钮状态可读（未开启/智能断句/文本校正/断句+校正），弹层白话文案（一句话讲清收益 + 失败自动回退的安心提示），服务商默认跟随翻译服务、不可解析就地红字提示
- [x] 8.3 采纳卡卡的「单条最长字数」设置：弹层与 AdvancedSheet 的 AI 档均暴露 maxSubtitleChars 输入（空 = 智能默认约 20 汉字），LLM 限长提示与物理护栏同源派生（limitsFromCueOptions 既有机制）
- [x] 8.4 回归：`check:i18n` 通过、组件零 lint；design.md UI 形态开放问题已回填结论
- [x] 8.5 去重合并：AdvancedSheet「字幕断句方式」回归三态（纯长度策略），移除其中的 AI 档/AI 校正开关/服务商选择——AI 配置统一由工具栏「AI 精修」承载；AI 断句开启时长度设置处展示关系说明（继续作为单条字数上限生效）
- [x] 8.6 修复向导页 AI 精修弹层顶部被遮挡：PopoverContent 约束到 Radix 视口可用高度（--radix-popover-content-available-height）+ 内部滚动 + collisionPadding
- [x] 8.7 终态整合：控件改名「断句与精修」，高级设置的「断句方式」整体迁入弹层（四选一：智能 / AI 语义 / 自定义上限 / 不限长 + 文本校正开关 + 服务商行），AdvancedSheet 不再有断句配置；按钮状态可读（智能断句 / AI 断句 · 校正 / ≤ N 字…）；与「字幕效果」档位（识别取舍）物理分离以消除概念重叠
- [x] 8.8 命名与文案：「智能断句」改名「标准断句（默认）」消除与 AI 的语义混淆（标准 = 零成本机械规则，AI = 语义理解），AI 档提示语精简；文档站开启路径同步新 UI
- [x] 8.9 修复校正遍术语注入风险（评审发现）：翻译术语块（原文→译文映射 + "使用指定译文"指令）会把转写原文改写成译文——anchored 协议改为注入「术语原文标准写法参考列表」（不含译文、全量限量、明示"非翻译"），legacyMap（校对台翻译优化）保持原语义；spec 新增「不因术语表引入译文」场景
- [x] 7.2 回归：`test:refine`（58）、`test:engines`（715）、`test:translate-parser`、`test:pipeline`、`test:recipes`、`test:glossary` 全部通过，`check:i18n` 通过；校对台 AI 润色改调共享服务（legacyMap 协议逐字保持既有格式），行为不变待随 7.1 一并人工复核
- [x] 7.3 文档：README（中/英/日）功能特性新增 AI 字幕精修条目；文档站新增 `advanced/ai-refine.md`（模型推荐、token 成本预期、Ollama 免费路径、近似模式与行为边界）

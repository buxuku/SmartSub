## Why

转写识别的三个核心旋钮——**上下文长度 `maxContext`**、**VAD 开关 `useVAD`**、**减少重复/幻觉 `reduceRepetition`**——对普通用户极难理解，尤其是它们的组合效果。更糟的是它们在代码层**彼此重叠且互相覆盖**：

- `maxContext`（`-1` 携带上文 / `0` 不携带）与 `reduceRepetition` 本质是同一根「要不要带上文」的杠杆；
- `reduceRepetition=ON` 会**强制** `max_context=0`（`builtinEngine.ts:99-101`），悄悄忽略用户在「上下文长度」里选的值——用户的选择形同虚设；
- 同一组合在不同引擎下利弊相反（`builtin-subtitle-timeline-0fork` 的 D14：开 VAD 让 builtin 分段更粗，却是 faster-whisper 的利好），导致 2×2×2 的组合里有若干自相矛盾项。

普通用户面对的是「机制旋钮 × 互相覆盖 × 引擎相关」的方程，无从下手。本变更用**「想要的效果 / 视频类型」**这一通俗维度，把这些复杂设置收敛成一个直白选择。

## What Changes

- **新增「字幕效果」意图档位**（3 档，单选）：`文字最准` / `均衡（默认）` / `最干净最稳`。用**「视频类型」当主标签、效果名当副标签**（口播·教程·短视频 / 通用 / 长视频·嘈杂·带音乐），因为普通用户更答得上「我的视频是什么样」而非「我想要什么效果」。
- **引擎感知映射**：同一档位按当前引擎翻译成**不同**的底层参数（builtin 映射 `VAD/maxContext/reduceRepetition`；faster-whisper 映射 `VAD/抗重复参数包`；funasr/qwen/fireRed 因 VAD 结构性常开、无上下文/抗重复概念，映射到 `VAD 灵敏度`，复用现有 Quiet/Standard/Noisy），把「意图→参数」这层差异化地藏在系统里。
- **逐任务运行时派生**：档位存在任务上，运行时按 `(档位×引擎)` 算出该次有效参数下发给引擎，**不回写任何全局开关**（避免 builtin↔faster-whisper 共享 `useVAD` 造成的跨引擎污染）；全局值仅作「自定义」档兜底。
- **单一事实来源**：档位成为底层参数的唯一来源，**修掉 `reduceRepetition` 静默覆盖 `maxContext`** 的混乱。
- **默认 + 反应式**：默认「均衡」，不强制用户选择；只在用户对结果不满意时，用**症状语言**反应式引导切档（「重复/鬼畜、静音处还在刷字幕」→ 更干净一档；「想要更准的字、更细的断句」→ 文字更准一档）。
- **样例对比**：在档位旁展示「同一段音频→相邻两档各出一小段字幕」的前后对比，让用户**一眼看懂**差异（无需理解任何原理）。
- **旧旋钮收进「自定义/高级」折叠区**作兜底：高级用户仍可单独调 VAD / 上下文 / 减少重复，能力零损失；现有非默认值识别为「自定义」档。

## Capabilities

### New Capabilities

- `transcription-outcome-presets`: 面向普通用户的「字幕效果」意图档位。把 `maxContext / useVAD / reduceRepetition` 三个互相重叠的机制旋钮，收敛成「视频类型 / 想要的效果」单选；按引擎差异化映射到底层识别参数；提供默认+反应式调整与档位样例对比；旧参数退居「自定义」折叠区作兜底。

### Modified Capabilities

<!-- openspec/specs/ 下当前无既有 spec（builtin-subtitle-timeline-0fork 尚未归档）；本变更新增 UI 抽象层、复用其既有引擎行为，不更改其 spec 级要求，故此处为空。 -->

## Impact

- **新增代码**：「意图→参数」映射纯函数（建议 `main/helpers/engines/outcomePresets.ts`，零运行时依赖、可被 `test:engines` 覆盖），输入 `{ outcome, engine }`，输出该引擎对应的底层参数集。
- **修改 UI**：
  - `renderer/components/tasks/AdvancedSheet.tsx`：识别区顶部加「字幕效果」档位选择 + 样例对比；现有 `maxContext` / `vad` / `reduceRepetition` 三块收进可折叠的「自定义」区。
  - `renderer/pages/[locale]/settings.tsx`：VAD 卡片改为「默认字幕效果」入口 + 高级折叠（保留现有 VAD 微调与三档环境预设于高级区）。
- **修改引擎**：`builtinEngine.ts` 与 `fasterWhisperEngine.ts` 改读「已解析的任务参数」而非直接读全局 `settings.useVAD`（逐任务运行时派生，见 design D10）；builtin 的 `max_context` 取值改由档位映射决定（消除 `isReduceRepetitionEnabled` 的静默覆盖）；funasr/qwen/fireRed 的 `buildXxxParams` 改读档位派生的 VAD 微调。
- **UI 顺手修正**：funasr/qwen/fireRed 任务的「自定义」区 **隐藏 `maxContext` / `reduceRepetition`**（这些参数对 sherpa 引擎本就无效，现有 `AdvancedSheet` 不分引擎一律显示属误导）。
- **存储**：`main/helpers/store/types.ts` + `store/index.ts` 新增档位字段（如 `subtitleOutcome: 'accurate' | 'balanced' | 'clean' | 'custom'`），`maxContext / useVAD / reduceRepetition` 保留为「自定义」档的底层值。
- **i18n**：`renderer/public/locales/{zh,en}/{tasks,settings,home}.json` 新增档位/场景/样例/反应式引导文案（`check:i18n` 通过）。
- **行为/兼容**：非破坏性。默认「均衡」对齐当前默认（VAD 开、`maxContext -1`、`reduceRepetition` 关）；老用户已设的非默认底层值迁移为「自定义」档，行为不变。**首版覆盖全部五个引擎**（builtin / faster-whisper / funasr / qwen / fireRed）；sherpa 三引擎按 VAD 灵敏度映射（design D9）。

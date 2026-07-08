## Context

转写识别区当前向用户暴露三个机制旋钮，分布在两处 UI（全局设置页 + 每任务高级面板），且彼此重叠/覆盖：

- **`maxContext`**（`AdvancedSheet.tsx` 下拉，`-1`/`0`）：home.json 已尝试用「最大化语义连贯性(-1) / 最小化字幕重复(0)」做半语义化标签。
- **`useVAD`**（全局设置 `settings.useVAD`，builtin / faster-whisper / funasr / qwen / fireRed 共用）：对 builtin 关=细准、开=粗稳；对 faster-whisper 开通常更好。
- **`reduceRepetition`**（全局设置）：builtin 强制 `max_context=0`；faster-whisper 套用一组抗重复参数（`condition_on_previous_text=false` 等，见 `transcribeShared.ts`）。

关键耦合证据：

```99:101:main/helpers/engines/builtinEngine.ts
      max_context: isReduceRepetitionEnabled(settings)
        ? 0
        : +(maxContext ?? -1),
```

即 `reduceRepetition` 一开，用户的 `maxContext` 选择被静默吞掉。`builtin-subtitle-timeline-0fork` 的 D14 已确认 `useVAD` 是跨引擎全局开关、不能简单翻转默认。

本变更不改任何引擎的识别行为，只在其**上方**加一层「意图→参数」的映射与 UI 收敛。

## Goals / Non-Goals

**Goals:**

- 普通用户只面对**一个**直白选择（视频类型/想要的效果），不接触 VAD/上下文/抗重复等机制词。
- 同一意图按引擎差异化映射到正确的底层参数，隐藏引擎差异。
- 消除「`reduceRepetition` 静默覆盖 `maxContext`」的混乱：底层参数有唯一事实来源。
- 默认零决策（均衡），仅在结果不满意时反应式引导切档。
- 高级用户能力零损失（旧旋钮收进「自定义」折叠区）。

**Non-Goals:**

- 不改 whisper.cpp / faster-whisper / funasr / qwen / fireRed 的识别算法与既有参数语义。
- 不改 `builtin-subtitle-timeline-0fork` 的时间轴管道（retime/clamp/merge/...）。
- 首版不做「按文件时长自动选档」（列入 Open Questions）。

## Decisions

### D1：三档单选，而非 2D 控件或连续滑杆

三个旋钮收敛后实为两维（①内容细度：VAD 关↔开、上下文 -1↔0；②稳健度：抗重复 关↔开、VAD 开），但二者在 builtin 上强相关（关 VAD 同时更细 + 更易在静音处出脏字），可压成一根「细准 ↔ 干净稳」轴上的 3 个停靠点。

- **否决 2D 控件**（拖拽板/双滑杆）：普通用户认知灾难、难取标签。
- **否决连续滑杆**：暗示无穷微调档、增加焦虑；离散 3 选一更笃定。
- 3 档也正是用户原始表述（内容/平衡/时间轴），天然好懂。

### D2：主标签用「视频类型」，副标签用「效果名」

novice 在**看到结果之前**没有参照系，给「准 vs 稳」只能瞎猜；但一定知道「我的视频长啥样」。故：

| 主标签（视频类型）            | 副标签（效果） | 适用                     |
| ----------------------------- | -------------- | ------------------------ |
| 口播 / 教程 / 短视频          | 文字最准       | 人声清晰、不太长         |
| 通用（推荐）                  | 均衡           | 大多数情况               |
| 长视频 / 嘈杂 / 带音乐 / 直播 | 最干净最稳     | 易重复/幻觉/需静音不出字 |

**绝不**用纯形容词（准/稳）单独区分——它是最弱的差异化手段。

### D3：引擎感知映射（同一档→不同底层参数）

映射纯函数 `resolveOutcomeParams(outcome, engine)`，单一出口，零运行时依赖、可单测：

| 档位                    | builtin                                                     | faster-whisper                           | funasr / qwen / fireRed（见 D9）                  |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| 文字最准 `accurate`     | `useVAD=false` · `maxContext=-1` · `reduceRepetition=false` | `useVAD=true` · `reduceRepetition=false` | VAD 灵敏（≈Quiet：低阈值/短静音，多抓语音少漏字） |
| 均衡 `balanced`（默认） | `useVAD=true` · `maxContext=-1` · `reduceRepetition=false`  | `useVAD=true` · `reduceRepetition=false` | VAD 标准（≈Standard）                             |
| 最干净最稳 `clean`      | `useVAD=true` · `maxContext=0` · `reduceRepetition=true`    | `useVAD=true` · `reduceRepetition=true`  | VAD 保守（≈Noisy：高阈值/长静音，静音噪声不出字） |

依据均来自 `builtin-subtitle-timeline-0fork` 的实测（D12/D13：builtin 关 VAD 19–20 条更细更准、开 VAD 12 条更稳；D14：VAD 对 faster-whisper 通常利好）。`maxContext` 对 faster-whisper 不生效，故不在其映射中。funasr/qwen/fireRed 的映射机制与 whisper 系**不同**（见 D9），但用户感知一致（更准/更全 ↔ 更干净/更稳）。

### D4：单一事实来源，消除静默覆盖

`builtinEngine` 的 `max_context` 不再读「`reduceRepetition ? 0 : maxContext`」这种双源覆盖，而是读**档位映射的派生值**（`clean` 档自带 `maxContext=0`）。`reduceRepetition`、`useVAD`、`maxContext` 在非「自定义」档下均为档位的派生值，不再各自为政。「自定义」档下三者恢复为用户直接可调的独立值。

### D5：默认「均衡」+ 反应式引导，而非强制选择

- 新任务默认 `balanced`，**不弹任何选择**——把「理解概念」从必经路径移除。
- 任务产出后，在结果区提供一句反应式引导（症状语言）：
  - 「字幕重复/鬼畜、静音处还在刷字幕」→ 一键切「最干净最稳」并可重跑；
  - 「想要更准的字、更细的断句」→ 一键切「文字最准」。
- 把「理解差异」降级为「看到结果后修毛病」。

### D6：档位旁「样例对比」（首版静态内置示例）

在档位选择旁提供「同一段音频，相邻两档各出一小段字幕」的对比卡片，让用户一眼看懂：

```
   【文字最准】                 【最干净最稳】
 断句更细、字更准              合并成块、略粗
 静音/音乐处可能冒脏字          静音处干净、不冒脏字
```

- **首版**：内置一段**精选静态示例**（固定文案对比图/表），零运行成本、确定性高。
- **进阶（Open Question）**：用用户**当前视频前 N 秒**实时跑两档生成真实对比，最直观但成本高。

### D7：旧旋钮收进「自定义」档，迁移现有值

- 新增 `subtitleOutcome: 'accurate' | 'balanced' | 'clean' | 'custom'`。
- 迁移：老用户若现有 `{useVAD, maxContext, reduceRepetition}` 恰好等于某档映射 → 归该档；否则归 `custom`（展开折叠区显示原值，行为不变）。
- 「自定义」折叠区保留全部现有控件（含 VAD 6 项微调 + 三档环境预设），高级用户能力零损失。

### D8：位置——建任务时为主，设置页存「默认档」

- 档位选择放在**建任务时**的识别区（此刻最清楚「这是什么视频」，且可逐文件覆写）。
- 设置页保留一个「默认字幕效果」给新任务继承（替代当前 VAD 卡片的主入口，VAD 微调下沉到高级）。
- 此布局为将来「按文件时长自动选档」留好钩子（建任务时已知时长）。

### D9：funasr / qwen / fireRed 的档位映射到「VAD 灵敏度」（机制不同、感知一致）

代码事实（`funasrEngine.ts` / `qwenEngine.ts` / `fireRedEngine.ts` 及对应 `*Params.ts`）：这三个 sherpa-onnx 引擎

- **段级时间戳直接来自 Silero VAD 分段**——VAD 是其「分段引擎」，**结构性常开、关不掉**（不读 `useVAD` 开关）；
- **不读 `maxContext` / `reduceRepetition`**（sherpa ASR 无 whisper 式「上文条件 / 上下文窗口」概念）。

故 whisper 系那套「VAD 开关 + 上下文 + 抗重复」对它们**两项不适用、一项锁死**。档位对这三个引擎改映射到**唯一真实可调的轴：VAD 灵敏度**——复用设置页已有的 `Quiet / Standard / Noisy` 三组 VAD 微调值（`vadThreshold` 等，已在 `settings.tsx` 的 `VAD_PRESETS`）：

- `文字最准` → 灵敏（≈Quiet，低阈值/短静音，多抓语音、少漏字）
- `均衡` → 标准（≈Standard）
- `最干净最稳` → 保守（≈Noisy，高阈值/长静音，静音/噪声不出字）

机制虽与 whisper 系不同，但**用户感知一致**（更准/更全 ↔ 更干净/更稳），符合「引擎感知映射」的初衷。相应地，这三个引擎的「自定义」折叠区 **MUST 隐藏 `maxContext` / `reduceRepetition`**（当前 `AdvancedSheet` 不分引擎一律显示，对 sherpa 引擎是误导，本变更顺手修正）。

**成本评估**：低-中。三引擎已把 VAD 微调集中在 `buildXxxParams(settings)`，只需让其读「档位派生的 VAD 微调」而非全局；`Quiet/Standard/Noisy` 值现成、无新管道、无新模型。主要成本在：①各引擎单独的映射行 + ②按引擎隐藏不适用旋钮 + ③标签语义复核。

**Alternatives：** 对这三个引擎让三档全等（无操作）——会误导（选了「文字最准」却毫无变化），否决；完全不给这三个引擎显示档位——可接受但不如映射到 VAD 灵敏度有价值。

### D10：VAD/上下文/抗重复改「逐任务运行时派生」，不再持久化全局开关（custom 档除外）

`useVAD` 当前是 builtin 与 faster-whisper **共享的全局开关**（`fasterWhisperEngine.ts:183` 与 builtin 同读 `settings.useVAD`）。档位却是逐任务的。两种落地方式比较：

| 方案                           | 逐任务表达     | 跨引擎污染                 | 设置面/迁移   | 代码量 |
| ------------------------------ | -------------- | -------------------------- | ------------- | ------ |
| 全局开关（现状）               | ✗ 不能         | 有（builtin↔fw 互相影响） | 现成          | 0      |
| 逐引擎全局（`builtinUseVAD`…） | ✗ 仍不能逐任务 | 无                         | +N 字段 +迁移 | 中     |
| **逐任务运行时派生（选定）**   | ✓              | 无                         | 无新持久字段  | **低** |

**决策：选「逐任务运行时派生」**。档位存在任务上（formData，与 `maxContext` 同源），运行时由 `resolveOutcomeParams(outcome, engine)` 算出该次运行的有效 `useVAD/maxContext/reduceRepetition`（及 sherpa 的 VAD 微调），**直接下发给引擎、不回写任何全局**。全局 `settings.{useVAD,maxContext,reduceRepetition}` 仅在 `custom` 档作为底层值。

为何是最佳 UX 且同时更省代码：

1. **逐任务正确**：同一批任务里「短片→文字最准」「长播客→最干净最稳」各取所需，全局开关（哪怕逐引擎）都表达不了。
2. **零跨引擎污染**：builtin 的 VAD 选择不会漏给 faster-whisper（按 `(档位×引擎)` 现算）。
3. **无新持久字段、无 N×M 迁移**：比「逐引擎全局」更省。
4. **契合心智**：「此档位对此引擎此刻=X」是临时派生量，不该是持久机器状态。

> 注：faster-whisper 与 builtin 当前直接读 `settings.useVAD`，本决策把它们改读「已解析的任务参数」——这正是档位本就要铺的管线（任务已携带 `maxContext` 等 formData），故运行时派生同时是**更低代码**的路径。

### D11：删除全局 VAD 总开关；`custom` 档 VAD/抗重复也改任务级（实现后反馈轮，选项 B）

实现联调后用户提出：设置页那个全局 `enableVad` 总开关与档位体系冲突。经核实确有两处冲突：

1. **总开关「说谎」**：选 `accurate/balanced/clean` 时 `useVAD` 已由「档位×引擎」在运行时决定（D3/D10）；用户在全局关掉开关，跑非 `custom` 档时 VAD 仍按档位运行 → 开关无效却仍在。
2. **隐蔽 bug**：VAD 灵敏度（`Quiet/Standard/Noisy` + 6 项滑块）原被 `{useVAD && ...}` 包裹；一旦关掉总开关，灵敏度整块消失，但 sherpa/balanced/clean 任务里 VAD 仍在跑，用户却再也调不了灵敏度。

**决策（选项 B）：**

- **设置页删除全局 VAD on/off 总开关**；VAD 灵敏度（预设 + 滑块）**始终显示**，定位为「VAD 灵敏度（在任何启用 VAD 的档位生效）」。VAD 开/关的唯一真相源 = 档位。
- **`custom` 档的 `useVAD` / `reduceRepetition` 从全局改为任务级**（写入 `react-hook-form` → `userConfig` formData，与 `maxContext` 同源）。`resolveEffectiveSettings` 的 `custom` 分支改为：`formData` 优先，缺省回落全局（老任务无任务级字段时行为逐字不变）。
- 由此**消除 D10 遗留的最后一处跨任务/跨引擎污染**：在某个任务的「自定义」面板里改 VAD/抗重复，不再 `setSettings` 写全局、不再影响其它任务与另一个 whisper 引擎。
- 全局 `settings.{useVAD,reduceRepetition}` 仍保留（不删字段），仅作 `custom` 档任务级缺省时的迁移回退值；全局灵敏度 `vadThreshold` 等保持全局（任何跑 VAD 的引擎共用）。

为何最佳：VAD 开/关本就是「档位×引擎」的派生量（D10），全局布尔与之并存必然产生「无效开关」；删除它让模型自洽。`custom` 档既然语义是「用户逐任务直调底层」，其 VAD/抗重复理应与 `maxContext` 一样任务级。

### D12：撤销设置页「默认字幕效果」卡片，档位收敛为纯任务级（推翻 D8 后半句）

D8 曾在设置页放一个「默认字幕效果」给新任务继承。实现后用户实测发现**双源冲突**：任务表单
（`userConfig`）本就是「上次使用」记忆、会持久化 `subtitleOutcome`；而设置页又是另一个默认源。
同一字段两个源 → 要么全局改动被任务旧值遮蔽，要么任务改动不被记忆，怎么调都别扭。

**关键事实**：本 app 里**没有任何其它任务字段**（译引擎/语言/模型/保存方式…）在设置页另设「全局默认」——它们都只靠 `userConfig` 的「上次使用」记忆。唯独给 `subtitleOutcome` 加一个全局默认，破坏了一致性，正是冲突来源。

**决策（选项 Y）：删除设置页「默认字幕效果」卡片**，`subtitleOutcome` 收敛为**纯任务级**：

- 仅在建任务的高级面板里选择，存 `userConfig.subtitleOutcome`，与其它任务设置一样「上次用什么、下次默认什么」。
- 全新安装的首个默认由 `getUserConfig` 惰性反推（`inferDisplayOutcome`：默认旋钮→`balanced`；老用户→对应档或 `custom`），迁移安全不变。
- 移除 `settings.subtitleOutcome` 字段与设置页相关 state/handler/i18n；`getSubtitleOutcome`/`inferDisplayOutcome` 的 `settings` 入参保留（前者作防御回退、后者用于迁移反推），但无 UI 写入。

为何最佳：与全 app 的「上次使用」心智一致、单一数据源、零冲突。用户要「设一次就一直用」，在高级面板选一次即被记忆，无需另一个全局开关。

## Risks / Trade-offs

- **[3 档无法覆盖所有组合]** → 「自定义」档兜底，高级用户不受限；普通用户用不到的组合本就不该暴露。
- **[引擎映射表是经验值、可能不适配所有素材]** → 沿用 0-fork 实测结论；映射集中在单一纯函数，便于后续按引擎/语言调参并单测。
- **[VAD 全局开关 vs 逐任务档位]** → 已由 D10 决策：改逐任务运行时派生、不回写全局；D11 进一步删除全局 on/off 总开关并把 `custom` 档 VAD/抗重复也改任务级，彻底消除跨引擎/跨任务污染。
- **[sherpa 引擎档位机制与 whisper 系不同]** → 已由 D9 决策：映射到 VAD 灵敏度（复用 Quiet/Standard/Noisy），用户感知一致；并按引擎隐藏不适用的 maxContext/reduceRepetition。
- **[反应式引导需要「重跑」]** → 复用现有任务重跑路径；切档即改该任务参数后重跑，不影响其它任务。
- **[静态样例与真实结果有差距]** → 首版样例标注「示意」；进阶做实时对比消除差距。
- **[迁移误判老用户档位]** → 等值匹配从严，任何不等即归 `custom` 并原样保留底层值，绝不改变老用户既有行为。

## Migration Plan

- 新增 `subtitleOutcome` 字段，默认 `balanced`；首启时按 D7 规则从现有 `{useVAD, maxContext, reduceRepetition}` 推断初值。
- 映射纯函数先落地 + 单测；再接 UI（AdvancedSheet → settings）；最后接引擎读取（builtin/fw 改读「已解析任务参数」、运行时派生，见 D10）。
- funasr/qwen/fireRed 按 D9 映射到 VAD 灵敏度（含按引擎隐藏不适用旋钮），**首版纳入**。
- 回滚：移除 UI 入口 + 让引擎回读旧 `settings` 字段即可；底层字段保持不变。

## Open Questions

- 「**按文件时长自动选档**」（建任务已知时长：短→文字最准、长→最干净最稳）→ **已确认列为后续**。
- 样例对比「用户视频前 N 秒实时对比」→ **已确认列为后续**（首版静态示意）。
- 反应式引导是否「记住用户对某类视频的偏好」（下次同类自动选）？后续。

> 实现说明（与原计划的有意偏差，均更安全/更省改动）：
>
> - 采用「**settings 叠加层**」而非改写各 `buildXxxParams` / `transcribeShared`：各引擎取 settings 后用
>   `resolveEffectiveSettings(formData, settings)` 叠一层派生值，既有 `getVadSettings` /
>   `isReduceRepetitionEnabled` / `buildXxxParams` 原样消费，改动面最小（§3.3/§3b.2 目标达成、零侵入）。
> - 迁移采「**惰性反推、绝不破坏**」：`subtitleOutcome` 不写 store 默认值（electron-store 会把默认值
>   合并进老用户配置，硬写 `'balanced'` 会回灌覆盖老用户自定义旋钮）。运行时 `getSubtitleOutcome`
>   未显式选档一律 `custom`（=沿用既有旋钮）；全新安装因默认旋钮恰等于 balanced 行为也等价（§2 见下）。
> - 顺带修复 sherpa worker 缺陷：识别器缓存键不含 VAD 参数，导致「同模型不同 VAD」复用 worker 时
>   静默沿用旧 VAD。已将 VAD 生命周期与识别器解耦（仅 VAD 变更只重建廉价 VAD），见 sherpa-worker.js。

## 1. 映射纯函数 + 类型 + 单测（先行，零运行时依赖）

- [x] 1.1 新建 `main/helpers/engines/outcomePresets.ts`：`SubtitleOutcome` 四档 + `resolveEffectiveSettings(formData, settings)`（按引擎差异化叠加底层参数，映射见 design D3/D9）
- [x] 1.2 反向推断 `inferSubtitleOutcome` / `inferDisplayOutcome`：等值匹配内置档则返回该档，否则 `custom`（仅供 UI 显示默认，design D7）
- [x] 1.3 单测（`test:engines`）：三档 × 引擎映射；`clean` 档 builtin 必含 `maxContext=0`；faster-whisper accurate 仍开 VAD；sherpa 仅动 VAD 灵敏度（不设 ctx/抗重复）；显式否则 custom；不可变更入参

## 2. 存储字段 + 迁移

- [x] 2.1 `store/types.ts`：新增 `settings.subtitleOutcome?`（联合类型）；保留 `useVAD/maxContext/reduceRepetition` 作为 `custom` 底层值
- [x] 2.2 **不**在 `store/index.ts` 写默认值（避免 electron-store 合并默认值回灌老用户）；迁移=运行时惰性反推（`getSubtitleOutcome` 未显式选档→`custom`，逐字保留既有行为），绝不改动既有底层值
- [x] 2.3 任务级默认项 `defaultUserConfig`：故意不加 `subtitleOutcome`（缺省即 custom 等价；用户首次选档后由 RHF 持久化进 userConfig）

## 3. 引擎读取改造（单一事实来源 + 逐任务运行时派生，design D10）

- [x] 3.1 `builtinEngine.ts`：`max_context` 改读叠加层派生值（`getNumericSetting(settings.maxContext,-1)`），移除原 `maxContext`（formData）直读；`custom` 档由叠加层回落 formData/全局
- [x] 3.2 `builtinEngine.ts` + `fasterWhisperEngine.ts`：取 settings 后过 `resolveEffectiveSettings`，`useVAD`/`reduceRepetition`/`maxContext` 来自派生值；**不回写全局**
- [x] 3.3 `transcribeShared.ts` 无需改：`isReduceRepetitionEnabled` / `getVadSettings` 直接消费叠加后的 settings，非 `custom` 档即得派生值，`custom` 档维持现状
- [x] 3.4 回归 builtin + faster-whisper：单测覆盖三档参数符合 D3 表、`custom` 与现状一致

## 3b. sherpa 引擎档位支持（funasr/qwen/fireRed，design D9；首版纳入）

- [x] 3b.1 `resolveEffectiveSettings` 为 funasr/qwen/fireRedAsr 输出「VAD 灵敏度」三档（Quiet/Standard/Noisy：文字最准≈Quiet、均衡≈Standard、最干净最稳≈Noisy）
- [x] 3b.2 `funasrEngine/qwenEngine/fireRedEngine` 的 transcribe + prewarm 双路径过叠加层；`buildXxxParams` 原样消费叠加后的 VAD 微调（`custom` 档回读全局）；fireRed 段长闸不受影响
- [x] 3b.3 单测：三引擎三档映射到对应 VAD 阈值；sherpa 不设 ctx/抗重复；`custom` 回退全局
- [x] 3b.4 worker 修复：`sherpa-worker.js` 将 VAD 与识别器分缓存键，避免「同模型换档不换 VAD」
- [ ] 3b.5 手动回归：三引擎三档对噪声/音乐素材产出「更全 ↔ 更干净」可感差异（需模型，待人工冒烟）— sherpa 系暂未纳入 `run-outcomes`（仅 builtin，见 §8.5）；可后续仿其扩展（需 funasr/qwen/fireRed 识别模型，非仅 VAD）

## 4. UI：建任务高级面板（AdvancedSheet）

- [x] 4.1 识别区顶部新增「字幕效果」四档单选（卡片：效果名 + 描述 + 适用场景；任务级 RHF 字段）
- [x] 4.2 现有 `maxContext` / `vad` / `reduceRepetition` 收进「自定义」档专属区；选 `custom` 才显示，其余档由映射派生
- [x] 4.4 **按引擎隐藏不适用旋钮**：funasr/qwen/fireRed 的自定义区隐藏 `maxContext` / `reduceRepetition`，改提示「VAD 结构性常开、细调去设置页」（design D9）
- [x] 4.3 切换档位即更新该任务参数；选中态清晰；`均衡` 标「推荐」

## 5. UI：设置页默认档 + 高级下沉

- [~] 5.1 ~~`settings.tsx` 新增「默认字幕效果」卡片~~ → **已在 §10.7 撤销**（选项 Y / D12：双源冲突，档位收敛为纯任务级）
- [x] 5.2 VAD 微调（6 项 + 三档环境预设）保持可折叠卡片，能力不减（注：全局 on/off 总开关在 §10 反馈轮按 D11 删除，灵敏度改为始终显示）

## 6. UI：样例对比 + 反应式引导

- [x] 6.1 档位旁「样例对比」可折叠卡片：静态示意（三档同句字幕呈现对比，design D6）
- [ ] 6.2 任务结果区反应式引导（症状语言 + 一键切档重跑，design D5）— **本期暂缓**（涉及结果区改造，用户首版明确要的是样例对比；待确认是否纳入）

## 7. i18n + 校验

- [x] 7.1 `locales/{zh,en}/tasks.json` 新增 `outcome.*`（档位名/描述/场景/样例对比）；`settings.json` 新增默认档卡片文案
- [x] 7.2 `check:i18n` 通过；改动文件无 lint 错误

## 8. 验证

- [x] 8.1 `npm run test:engines` 全过（229 passed，含新增映射/推断/迁移测试）
- [~] 8.2 手动回归：**builtin 三档**已由 §8.5 真机 harness 覆盖（有可复现证据）；**faster-whisper** 三档（需 Python 运行时、不在本 harness）仍待人工冒烟
- [x] 8.3 迁移回归：单测覆盖「未显式选档→custom（行为不变）」「全新默认→balanced 等价」
- [x] 8.4 确认 `reduceRepetition` 不再静默覆盖：均衡档 builtin 实际 `max_context=-1`、`reduceRepetition=false`（单测断言）
- [x] 8.5 真机三档验证 harness `scripts/longgap/run-outcomes.ts`（`npm run test:longgap:outcomes`）：走**真实** `resolveEffectiveSettings` 跳三档（builtin），与 `run.ts` 同源 whisper + subtitleSegmentation，量化 chars/dup/inSilence/cues/short 梯度并写 `tier-*` SRT。**证据**（en/music, base-q8_0, 加大音乐床）：`accurate`(VAD off) inSilence=3 → `balanced`/`clean`(VAD on)=0「静音不冒字」；同处 47s `accurate`(ctx=-1) 出「Artificial intelligence technology」正确、`clean`(ctx=0) 退化为「What official intelligence technology」，印证「文字最准 ↔ 最干净最稳」权衡。**发现**：简单/安静素材三档收敛（属预期——差异只在噪声/音乐/长静音显现；启示样例对比应用难素材真实差异，勿在干净短片过度承诺）

## 9. 后续（已确认列为后续，不阻塞本期）

- [ ] 9.1 「按文件时长自动选档」选项（建任务时已知时长）— 用户已确认后续
- [ ] 9.2 样例对比升级为「用户视频前 N 秒实时跑两档」真实对比 — 用户已确认后续
- [ ] 9.3 记住用户对某类视频的档位偏好（下次同类自动选）

## 10. 实现后反馈轮（用户联调反馈，design D11）

- [x] 10.1 默认档=均衡：`getUserConfig` 惰性注入 `subtitleOutcome`（缺省按 `inferDisplayOutcome` 反推，全新→balanced），不破坏老用户既有底层值（反馈#1）
- [x] 10.2 `AdvancedSheet`：选「自定义」时底层旋钮紧贴档位选择器正下方展开，样例对比移至其后（反馈#3）
- [x] 10.3 删除设置页全局 VAD on/off 总开关；VAD 灵敏度（预设 + 6 项滑块）改为始终显示，文案改为「灵敏度（在任何启用 VAD 的档位生效）」（反馈#2 / D11）
- [x] 10.4 `custom` 档 `useVAD` / `reduceRepetition` 改任务级（写 RHF→userConfig）；`resolveEffectiveSettings` 的 custom 分支 formData 优先、缺省回落全局；消除跨任务/跨引擎污染（D11）
- [x] 10.5 单测补充：custom 档任务级 useVAD/reduceRepetition 覆盖全局、缺省回落全局（`test:engines` 233 passed）；i18n 新增 `vadSensitivityNote`、parity 通过
- [x] 10.6 ~~修复「全局默认档不影响新建任务」：`setSettings` 同步写 `userConfig.subtitleOutcome`~~ → 被 §10.7 取代（用户指出全局默认与任务级「上次使用」记忆本质冲突）
- [x] 10.7 **撤销设置页「默认字幕效果」卡片，档位收敛为纯任务级（选项 Y / D12）**：移除 settings.tsx 卡片 + state + handler + 相关 import；移除 `setSettings`→userConfig 同步；移除 `settings.subtitleOutcome` 类型字段与 `defaultOutcome*` i18n；首个默认仍由 `getUserConfig` 惰性反推（balanced/迁移安全）。`test:engines` 233 passed、`check:i18n` 通过、lint 干净

<!-- 已在本期决策、不再是 Open Question：funasr/qwen/fireRed 映射=VAD 灵敏度（§3b / D9）；VAD 作用域=逐任务运行时派生（§3 / D10，已否决「逐引擎全局 VAD」）；全局 VAD 总开关删除、custom 档 VAD/抗重复任务级（§10 / D11）。 -->

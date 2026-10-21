## Why

[#549](https://github.com/buxuku/SmartSub/issues/549) 报告：Qwen3-ASR 1.7B 对长连续语音「静默失败」——VAD 单段超过约 38 秒时输出空文本或字面量 `language`，任务仍显示 completed。

我们在源码层面核实过，这是确定性的，不是偶发。Qwen3-ASR 是 LLM 式解码：音频按约 13 token/秒编码，与提示词（约 15 token）、生成文本共用同一个 `max_total_len`（sherpa-onnx 默认 512，妙幕原样沿用，`max_new_tokens` 默认 128）。按这个预算，单个 VAD 段超过约 28 秒，文本可能在生成循环触顶处被静默截断（没有任何日志）；超过约 38 秒，音频 placeholder 被截到刚好塞满预算，生成循环首步即退出，只剩首个 token（常见就是 `language`）。

而妙幕里 Qwen 的「最长语音」默认是 0，经 `sherpaConfig.ts` 映射为 100000 秒，实际不限，VAD 想切多长就多长。同一版本里的 FireRedASR 已经有段长安全闸（`clampFireRedMaxSpeech`），Qwen 没有。上游 [sherpa-onnx#4034](https://github.com/k2-fsa/sherpa-onnx/issues/4034) 已于 2026-10-20 以 not planned 关闭，维护者的答复是「请用 VAD 切段」，补丁 PR [#4035](https://github.com/k2-fsa/sherpa-onnx/pull/4035) 尚未合并，等不来修复。

用户也没有办法自己绕开：任务设置里的「最长语音」滑块只在「更多设置 › 专家」选了「手动调节」之后才出现；选准确 / 均衡 / 干净任一档时，界面里没有这个滑块，全局值也会被档位覆盖为 0（`types/subtitleOutcome.ts` 的 sherpa 分支）。所以默认值本身必须是安全的。

触发条件是「单段连续语音超过约 28 秒」。常规带停顿的语音会被 VAD 切成较短的段（本机合成语音里最长约 8 秒），不受影响；容易触发的是去掉气口的口播、AI 配音、快速连读、静音被背景音乐盖住的素材（这是推断，没有线上统计）。

## What Changes

- **段长安全闸**：`buildQwenParams` 在把 VAD 参数交给 sherpa-onnx 之前收敛「最长语音」：未设、0、非数值、负数取 15 秒；大于 20 秒取 20 秒；其余原样。`0` 在 Qwen 上不再意味着「不限」。预算线是 (512 − 15 − 128) ÷ 13 ≈ 28 秒；sherpa VAD 的最长语音只是软限制，本机探针里过冲呈长尾，15 秒与 20 秒是按探针数据挑的，见 design D2
- **这只是降低概率，不是根治**：探针里即使上限取 15 秒，仍有约两成的音频落在超预算段里，完全无停顿的素材限制无效。真正消除风险需要 worker 级硬切分，列为首要后续项（tasks 8.2）
- **超预算告警**：转写完成后，按实际生效的 `max_total_len` / `max_new_tokens` 估算每个 VAD 段所需 token；超出预算的段汇总成一条 warning 日志（段数、最长段、能放下的最长秒数）。只写日志，不改变转写结果
- **文案与文档**：设置页「最大语音持续时间」的提示注明 Qwen3-ASR（0 = 自动 15 秒，最多 20 秒）与 FireRedASR（最多 60 秒）两个例外；Qwen3-ASR 引擎文档补一条「长连续语音被截断」的常见问题，说明安全闸、日志警告，以及在「手动调节」里调小的办法
- **行为变化**：原本 15–28 秒且能正常识别的 Qwen 段，现在会在 15 秒之后的第一个 VAD 停顿处被切开，断句略碎；显式设置大于 20 秒会被收敛到 20 秒
- 不在本次范围：
  - worker 级硬切分（首要后续项）
  - 全局放大 `max_total_len`、在界面开放 `qwenMaxTotalLen` / `qwenMaxNewTokens`
  - 在文本层过滤裸 `language`（`qwenText.ts` 的原则是不靠文本猜测幻觉）
  - 升级 sherpa-onnx、修改全局「最长语音」默认值
  - 让告警进入任务界面
  - 以上见 tasks 第 8 节

## Capabilities

### New Capabilities

- `qwen-asr-segment-budget`: Qwen3-ASR 的 VAD 单段时长安全闸、超解码预算告警，以及对应的提示文案与文档说明

### Modified Capabilities

（无）

## Impact

- 主进程：`main/helpers/engines/qwenParams.ts`（新增常量、`clampQwenMaxSpeech`、`estimateQwenTokens`、`findQwenOverBudgetSegments`，并接入 `buildQwenParams`）、`main/helpers/engines/qwenEngine.ts`（转写后记 warning）
- 不改：sherpa worker、`sherpaConfig.ts`、`types/subtitleOutcome.ts`。worker 的 `buildVadKey` 已包含最长语音，值变化时只重建廉价的 VAD，不重载 ASR 模型
- CLI / MCP：走同一个 Qwen 适配器，自动受益
- 渲染层：只改 zh / en `settings.json` 里 `vadMaxSpeechDurationTip` 的文字，不增删 key
- 文档：`docs/docs/guides/engines/qwen3-asr.md`
- 测试：`scripts/test-engine-units.ts`、`scripts/test-qwen-scaffold.cjs`，均已并入 `yarn test:engines`
- 无新增依赖，无数据迁移；已保存的设置不变，行为变化即时生效

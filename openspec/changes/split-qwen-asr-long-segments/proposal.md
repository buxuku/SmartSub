## Why

[#562](https://github.com/buxuku/SmartSub/pull/562)（变更 `fix-qwen-asr-long-segments`，下称「前一个变更」）给 Qwen3-ASR 加了段长安全闸和超预算告警，但它只能降低超预算的概率。sherpa VAD 的「最长语音」是软限制：超过之后只是把最短静音降到 0.1 秒、阈值升到 0.90，从不硬切。前一个变更的本机探针里，完全没有停顿的素材在任何上限下都只有一整段（145 秒、123 秒），上限取 15 秒时仍有约两成音频落在超过 28 秒的段里。

[#549](https://github.com/buxuku/SmartSub/issues/549) 的复现素材正是这一类：`silenceremove` 去掉了全部停顿，VAD 只切出 4 段，最长 56.4 秒。闸管不了它。VAD 交给 worker 多长的段，现在就整段喂给 Qwen，文字被截断或音频被丢掉，任务照样显示 completed。sherpa-onnx 维护者在 #549 里的建议也是把段切到 20 秒以内。所以要在 VAD 之后、识别之前，对仍然超长的段做硬切分。前一个变更已把它列为首要后续项（该变更 tasks 8.2）。

## What Changes

- **硬切分**：sherpa worker 在 VAD 出段之后、创建识别 stream 之前，把时长超过上限 `segment_hard_max_s` 的段切成若干片，每片不超过上限，各自解码、各自成 cue。切点取理想等分点前后 2 秒内能量最低的 20 ms 帧：有残余停顿时切在停顿里，完全没有停顿时切在语音里最安静的帧（仍可能落在词中，这是固有限度）。不丢音频
- **只给 Qwen3-ASR 启用**：`buildQwenParams` 把 `segment_hard_max_s` 设为 `min(20, 解码预算能容纳的秒数)`，默认 20 秒。参数缺省或为 0 时 worker 的行为与现在一致；其他引擎的请求不带这个参数
- **呈现与告警**：被切的段通过 worker 的 `done` 消息回报（新增 `splits`），引擎记一条 info 日志；`vadSegments` 改为实际送去解码的片，前一个变更的超预算告警随之只在切分被关掉、或预算被调小到放不下时触发，作为兜底
- **文档**：Qwen3-ASR 常见问题改写，如实说明切点策略，以及「没有停顿的素材切点可能落在词中」
- **行为变化**：时长超过 20 秒的 VAD 段现在被切成多个 cue；其中 20–28 秒、原本放得进预算的段也会被切开（见 design D3 的取舍）。20 秒以内的段完全不变
- 不在本次范围：
  - 重叠窗口加文本合并、对长段重跑更严的 VAD（见 design D2 的替代方案）
  - 在界面开放开关或上限
  - 给 FireRedASR、FunASR、Parakeet 启用（机制是通用的，之后传同一个参数即可）
  - 升级 sherpa-onnx，改动前一个变更的钳制与默认值
  - 让切分提示进入任务界面

## Capabilities

### New Capabilities

- `qwen-asr-segment-split`: Qwen3-ASR 超长 VAD 段在 worker 里按最安静处硬切分，及其参数、结果呈现与文档说明

### Modified Capabilities

（无。前一个变更的 `qwen-asr-segment-budget` 尚未归档，本变更不修改它，只在 design 里说明告警计算对象的变化）

## Impact

- worker：新增 `extraResources/sherpa/worker/segment-split.js`（纯函数，无依赖）；`sherpa-worker.js` 的 `transcribe()` 接入；`done` 消息新增 `splits`
- 主进程：`main/helpers/engines/qwenParams.ts`（`segment_hard_max_s`）、`main/helpers/sherpaOnnx/sherpaFunasrRuntime.ts`（`splits` 与参数的类型透传）、`main/helpers/engines/qwenEngine.ts`（info 日志、告警对象）
- 不改：`sherpaConfig.ts`；VAD 参数与缓存键（切分在 VAD 之后，不影响 VAD 与识别器实例的复用）；`types/subtitleOutcome.ts`
- 打包：`electron-builder.yml` 在三个平台上都把 `extraResources/sherpa/` 以 `**/*` 整目录打包，新文件自动随包
- CLI / MCP：走同一个 Qwen 适配器，自动受益
- 文档：`docs/docs/guides/engines/qwen3-asr.md`
- 测试：新增 `scripts/test-segment-split.cjs`；扩充 `scripts/test-sherpa-worker.cjs`、`scripts/test-engine-units.ts`、`scripts/test-qwen-scaffold.cjs`；均并入 `yarn test:engines`（该命令也在 Windows CI 上跑）
- 前置：依赖前一个变更的 `QWEN_HARD_MAX_SPEECH_S` 与 `findQwenOverBudgetSegments`，所以分支叠在 `fix/issue-549-qwen-asr-long-segments`（#562）之上
- 无新增依赖，无数据迁移；已保存的设置不变

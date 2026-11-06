# Tasks: fix-qwen-asr-long-segments

## 1. 分支与脚手架

- [x] 1.1 从干净且与 `origin/main` 同步的 `main` 新建 `fix/issue-549-qwen-asr-long-segments`
- [x] 1.2 `openspec new change` 并撰写 proposal / design / specs / tasks，`openspec validate fix-qwen-asr-long-segments --strict` 通过

## 2. 本机探针（不入库，先于定稿常量）

- [x] 2.1 用 `say` 加 `ffmpeg silenceremove` 造稠密连续语音，经本机 sherpa 原生库与随包 Silero VAD 统计分段时长，核对「过冲不超过 6 秒」。结果：假设不成立，过冲呈长尾（中位数约 5 秒，p90 约 18–28 秒，无停顿时不切）。数据与方法写入 design.md，默认值与上限由最初的 20 / 22 秒下调为 15 / 20 秒，spec 与测试按新值编写

## 3. 段长安全闸（测试先行）

- [x] 3.1 先写失败测试（`scripts/test-engine-units.ts`）：默认参数期望的 `vad_max_speech_duration_s` 由 0 改为默认 15；钳制用例：0、未设、NaN、负数得 15，12 与 20 原样，25 与 60 得 20。确认测试因功能缺失而变红
- [x] 3.2 `qwenParams.ts` 新增常量与 `clampQwenMaxSpeech`，接入 `buildQwenParams`；确认变绿

## 4. 超预算告警（测试先行）

- [x] 4.1 先写失败测试：`scripts/test-engine-units.ts` 覆盖估算边界（28 秒放行、30 秒告警、预算 1024 / 256 时 45 秒放行）与 `findQwenOverBudgetSegments`（空输入、全部合规、混合、最长段）；`scripts/test-qwen-scaffold.cjs` 把 `logMessage` 桩改成记录调用，新增 45 秒 VAD 段夹具，断言记一条 warning 且字幕产出不变，既有夹具不产生告警。确认变红
- [x] 4.2 `qwenParams.ts` 新增 `estimateQwenTokens` 与 `findQwenOverBudgetSegments`，`qwenEngine.ts` 在转写完成后记 warning；确认变绿

## 5. 文案与文档

- [x] 5.1 `docs/docs/guides/engines/qwen3-asr.md` 常见问题补一条「长连续语音被截断」，并更新页脚日期
- [x] 5.2 zh / en `settings.json` 的 `vadMaxSpeechDurationTip` 注明 Qwen3-ASR 与 FireRedASR 的例外；`yarn check:i18n` 通过

## 6. 本机验证（macOS，提交前逐条实跑）

- [x] 6.1 `yarn typecheck`：通过（renderer / main / automation / scripts/crash 四个 tsc 项目均无错误）
- [x] 6.2 `yarn test:engines`：通过（引擎单测 1127 项 0 失败；sherpa worker、运行时失败、wav-io 22 项、Qwen scaffold 脚本均通过）
- [x] 6.3 `yarn test:scenario-presets`：通过（场景预设、适配器、场景语言三个脚本）
- [x] 6.4 `yarn check:i18n`：通过（zh / en 键一致，无回退写法）
- [x] 6.5 `openspec validate fix-qwen-asr-long-segments --strict`：通过
- [x] 6.6 `prettier --check` 覆盖本分支改动的全部文件：通过（12 个文件）
- [x] 6.7 计划外的补充回归：`yarn test:automation:regressions`（CLI / MCP 共用适配器）与 `yarn test:sherpa-json` 均通过

## 7. 未验证项（需要真实环境，请勿当作已验证）

- [ ] 7.1 真实 Qwen3-ASR 模型的端到端复测：本机没有模型。建议 issue 作者用修复后的构建，在 silenceremove 素材（40 秒以上）上复测，确认不再出现 `language` / 空文本
- [ ] 7.2 过冲与单段长度在真实素材上的分布：目前只有 issue 附件的一个数据点（过冲约 6 秒）和本机合成语音探针（design 的两张表）
- [ ] 7.3 告警在真实日志文件里的出现形态（与原生层的 `asr worker stderr` 行并存时是否容易辨认）

## 8. 后续（不在本次范围）

- [ ] 8.1 升级 sherpa-onnx 到 1.13.7 以上（上游 [#3873](https://github.com/k2-fsa/sherpa-onnx/pull/3873)：1.7B 特征前端偏移修复与重复循环防护，可能与 issue 作者描述的段边界损坏有关，未验证），并复核本变更里与 v1.13.2 绑定的常量
- [ ] 8.2 **首要后续项**：worker 级硬切分。本变更只降低超预算的概率；探针里即使上限取 15 秒，仍有约两成音频落在超预算段里，无停顿的素材限制完全无效。做法是在 worker 里对超长段按能量最低点再切（避开词中），要与 `sherpaConfig.ts` 双份维护并补端到端验证
- [ ] 8.3 让超预算告警进入任务界面
- [ ] 8.4 FireRedASR 的 `clampFireRedMaxSpeech` 只在「未设置」时取默认 30 秒；全局默认的 `0` 属于「已设置」，会被钳到 60 秒硬上限，没有软限制过冲余量。评估是否也应把 `0` 当作「自动」
- [ ] 8.5 任务设置里「最长语音（秒，0 为不限）」的标签按引擎区分文案（Qwen3-ASR、FireRedASR 的 0 不再表示不限）

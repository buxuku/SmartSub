## 1. 版本闸门：确认 sherpa 库 + JS 封装支持 FireRedASR（D9，已天然通过）

- [x] 1.1 核实 vendored `extraResources/sherpa/vendor/types.js` 已声明 `OfflineFireRedAsrModelConfig { encoder, decoder }` 并纳入 `OfflineModelConfig.fireRedAsr`（已确认）
- [x] 1.2 核实 `non-streaming-asr.js` 的 `OfflineRecognizer` 为纯 pass-through（`addon.createOfflineRecognizer(config)`，无模型类型白名单），故传入 `modelConfig.fireRedAsr` 直达原生绑定，**无需改 wrapper / 无需 re-vendor**
- [x] 1.3 核实 FireRedASR C/Python API 自 sherpa-onnx PR #1867 合入，pin 的 1.13.2 原生库已含，**无需 bump `SHERPA_VERSION` / 无需引擎仓重打**
- [ ] 1.4 hello-decode 运行时验证（下载 sherpa 库 + FireRedASR 模型 → 构造 fireRedAsr recognizer → 对 16k/mono wav decode 出非空文本）—— 归入 8.3 端到端冒烟（需运行时下载，非纯逻辑）

## 2. 识别器配置：新增 fire_red_asr 分支（D2 / D3）

- [x] 2.1 扩展 `SherpaModelRequest`（`sherpaOnnx/sherpaFunasrRuntime.ts`）：`modelType` 加 `'fire_red_asr'`，新增 `fireRed?: { encoder: string; decoder: string }` 字段，复用既有可选 `tokens` 承载 tokens.txt，`params` 联合加 `FireRedAddonParams`
- [x] 2.2 `sherpaConfig.ts` 新增 `buildFireRedRecognizerConfig`（独立函数，不改 `buildRecognizerConfig` / `buildQwenRecognizerConfig`，保既有单测不破）：映射 `modelConfig.fireRedAsr = { encoder, decoder }` + 顶层 `tokens` + `numThreads/provider/debug`；`featConfig` 保持 `{ sampleRate:16000, featureDim:80 }`
- [x] 2.3 `extraResources/sherpa/worker/sherpa-worker.js` 内联等价 `buildFireRedRecognizerConfig` + `ensureLoaded` 按 `modelType` 选分支；`buildKey` 纳入 `fire_red_asr`（encoder|decoder|tokens|num_threads|provider|VAD 字段；无解码超参）
- [x] 2.4 `test:engines` 补 fire_red_asr 映射单测（encoder/decoder/顶层 tokens + provider/num_threads + 共享 VAD + `buildFireRedParams` 默认值，含段长安全闸钳制）

## 3. 运行时入口复用（D4）

- [x] 3.1 复用既有引擎无关入口 `getSherpaAsrRuntime`（Qwen 阶段已就位）；FireRedASR 适配器直接使用，零改运行时类
- [x] 3.2 缓存 key 由 `buildKey` 按 modelType + 模型路径 + 参数生成，funasr↔qwen↔firered 切换自动重建、同引擎命中不重建

## 4. FireRedASR 模型清单与下载（D5）

- [x] 4.1 新增 `main/helpers/fireRedModelCatalog.ts`：`FIRERED_MODELS`（默认 `fire-red-asr-large-zh-en`：ModelScope 逐文件 + release tar.bz2 整包 + 体积 + `requiredFiles=[encoder.int8.onnx, decoder.int8.onnx, tokens.txt]`）、`getFireRedModelDir`、`isFireRedModelInstalled`、`getInstalledFireRedModels`、`resolveFireRedSelection`、`getFireRedModelFiles`、`deleteFireRedModel`、源回退 `getFireRedSourceOrder`
- [x] 4.2 经 ModelScope 文件树 API（仿 `getQwenModelScopeTreeUrl`）核实仓库 `csukuangfj/sherpa-onnx-fire-red-asr-large-zh_en-2025-02-16` 内 encoder/decoder/tokens 的 remote 路径与 size，填入 `modelScopeFiles`
- [x] 4.3 `isFireRedReady` 校验三件套齐全 **且** silero VAD 存在（复用 FunASR 的 `models/funasr/silero-vad/silero_vad.onnx`，经 `isFireRedVadInstalled`=`isFunasrModelInstalled('silero-vad')` 判定）
- [x] 4.4 新增 `main/helpers/fireRedModelDownloader.ts`（仿 `qwenModelDownloader.ts`）：ModelScope 逐文件直下（免解包）/ ghproxy·github 整包 `downloadFileParallel`（断点续传/并行）+ 镜像回退 + `extractArchive`（system tar，strip:1，excludeContains:'test_wavs'），落 `userData/models/firered/<id>/`；进度 key `firered:<id>`
- [x] 4.5 silero VAD 缺失时由 `FireRedModelSection` 引导下载，复用 funasr 的 `downloadFunasrModel('silero-vad')`（同一文件，不重复存储）

## 5. 引擎适配器与注册（D6 / D7 / D8）

- [x] 5.1 新增 `main/helpers/engines/fireRedParams.ts`：`provider`（cpu only 本期）/ `num_threads` + 复用 VAD 调参；**段长安全闸（D8）**：`vad_max_speech_duration_s` 默认 30，且映射时硬钳 ≤60；无解码超参、无 language；`buildFireRedParams(settings)`
- [x] 5.2 新增 `main/helpers/engines/fireRedEngine.ts`（仿 `qwenEngine.ts`）：`id:'fireRedAsr'`、`requiresRuntime:true`、无 `pyEngineId`；`isAvailable`=sherpa 库已装 && `isFireRedReady`；`transcribe`/`cancelActive`/`prewarm` 走 `getSherpaAsrRuntime`，模型请求 `{ modelType:'fire_red_asr', fireRed:{encoder,decoder}, tokens, vadModel, params }`
- [x] 5.3 `types/engine.ts`：`TranscriptionEngine` 加 `'fireRedAsr'`
- [x] 5.4 `main/helpers/engines/registry.ts`：注册 `fireRedEngineAdapter`
- [x] 5.5 `main/helpers/taskProcessor.ts`：`isRestrictiveEngine` 加 `fireRedAsr`（并发钳制=1，与 funasr/qwen 共用 sherpa worker）

## 6. 任务侧接线与 IPC

- [x] 6.1 IPC：模型下载/状态/删除落在 `systemInfoManager.ts`（`downloadFireRedModel`/`getFireRedModelStatus`/`deleteFireRedModel`，删除前 `getSherpaAsrRuntime().dispose()` 释放文件锁）；`openModelsFolder` 的 `pathType` 加 `'firered'`
- [x] 6.2 `ipcEngineHandlers.ts` 加 `set-firered-settings`（provider/numThreads，写入 store.settings.fireRed\*）；`main/helpers/store/types.ts` 增 fireRed 设置字段
- [x] 6.3 `systemInfoManager.ts`：`getSystemInfo` 输出 `fireRedEngineInstalled`/`fireRedVadInstalled`/`fireRedModelsInstalled`/`fireRedModelsPath`

## 7. 资源中心 UI 与跨引擎接线、i18n

- [x] 7.1 `renderer/lib/engineModels.ts`：`EngineModelInfo` 加 fireRed 字段；`getInstalledModelsForEngine`/`getSelectableModelsForEngine`/`hasModelsForEngine`/`getEngineModelGroups`/`hasAnyModelAnyEngine` 加 `fireRedAsr` 分支（VAD+模型+运行库三就绪才出分组）
- [x] 7.2 `EngineModelTab` 引擎列表加 `fireRedAsr`（`EngineIcon` 配色 + 状态点/徽章）+ 右栏 `FireRedPanel`（共享 `SherpaRuntimePanel`，含 numThreads）+ `FireRedModelSection`（模型行 + 共享 VAD 行）
- [x] 7.3 `FireRedModelSection` 下载前 `AlertDialog` 体积二次确认（约 1.7GB）+ 源选择（modelscope/ghproxy/github）；`engines.fireRedAsr.desc` 标注「中英混说/方言强、CPU 友好但非实时」
- [x] 7.4 任务页 `Models`/`InlineConfigBar` 透传 `fireRed{Vad,Models,Engine}Installed`，`getEngineModelGroups` 仅在运行库+VAD+模型三者就绪时出现 fireRedAsr 分组
- [x] 7.5 新增 fireRedAsr i18n：`resources.json` engines.fireRedAsr.\*（含 models.<id>.name/desc、modelSources、段长说明）+ `common.json` engineBadge.fireRedAsr（中英双语），过 `yarn check:i18n`

## 8. 验证与回归

- [x] 8.1 `npx tsc --noEmit -p renderer/tsconfig.json` 通过：所触 fireRed/UI 文件零类型错误
- [x] 8.2 `yarn test:engines` 通过（含 fire_red_asr 配置映射 + `buildFireRedParams` 默认值与 60s 钳制单测）
- [ ] 8.3 端到端冒烟：下载 sherpa 库 + FireRedASR 模型（ModelScope 与整包源各验一次）→ 选 fireRedAsr → 预热 → 出 SRT（段级时间戳）；进度/取消正常
- [ ] 8.4 长音频验收（D8 关键）：对含 >60s 连续语音的音频转写，段长被钳制、无幻觉、无位置编码报错
- [ ] 8.5 Windows 冒烟：首个 fireRedAsr 转写不卡 0%（worker 线程）
- [ ] 8.6 回归：faster-whisper / FunASR / Qwen / whisper.cpp 行为不受影响

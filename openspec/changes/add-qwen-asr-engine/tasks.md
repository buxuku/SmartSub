## 1. 版本闸门：确认 sherpa 库 + JS 封装支持 Qwen3-ASR（D8，先行验证）

- [x] 1.1 核实 `sherpa-onnx-node` 1.13.2 原生库含 Qwen3-ASR 离线识别器 —— 上游 `OfflineQwen3ASRModelConfig` 自 v1.12.34 加入，绑定 `non-streaming-asr.cc` 读取 `obj.Get("qwen3Asr")` 并赋值 `c.qwen3_asr`；1.13.2 ≥ 1.12.34，故已包含（live hello-decode 见 8.3）
- [x] 1.2 核实 vendored JS：`non-streaming-asr.js` 的 `OfflineRecognizer` 为纯 pass-through（`addon.createOfflineRecognizer(config)`，无模型类型白名单），故传入 `modelConfig.qwen3Asr` 直达原生绑定，**无需改 wrapper**；`types.js` 的 JSDoc 缺 `qwen3Asr` 仅为文档滞后（运行时无影响，将补 typedef）
- [x] 1.3 不需要：引擎仓 sherpa 重打包流水线已托管 1.13.2（含 Qwen3-ASR），无需升级/重发
- [x] 1.4 不需要：wrapper pass-through，无需 re-vendor JS，无需 bump `SHERPA_VERSION`
- [ ] 1.5 hello-decode 运行时验证（下载 1.13.2 sherpa 库 + qwen 0.6B 模型 → 构造 qwen recognizer → 对 16k/mono wav decode 出非空文本）—— 归入 8.3 端到端冒烟（需运行时下载，非纯逻辑）
- [x] 1.6 补 `extraResources/sherpa/vendor/types.js` 的 `OfflineQwen3ASRModelConfig` typedef（含 memset(0) 提示）+ 加进 `OfflineModelConfig`（文档一致性，运行时无依赖）

## 2. 识别器配置：新增 qwen3_asr 分支（D2 / D3）

- [x] 2.1 扩展 `SherpaModelRequest`（落在 `sherpaOnnx/sherpaFunasrRuntime.ts`，请求类型的就近位置）：`modelType` 加 `'qwen3_asr'`，新增 `qwen` 四件套字段（convFrontend/encoder/decoder/tokenizer），`asrModel`/`tokens` 改为可选，`params` 联合 `FunasrAddonParams | QwenAddonParams`
- [x] 2.2 `sherpaConfig.ts` 新增 `buildQwenRecognizerConfig`（独立函数而非改 `buildRecognizerConfig` 签名，保持 funasr 既有单测不破）：映射 `modelConfig.qwen3Asr = { convFrontend, encoder, decoder, tokenizer, maxTotalLen, maxNewTokens, temperature, topP, seed }`；`buildVadConfig` 形参放宽为结构化 `SherpaVadParams` 供两引擎共享。**关键**：原生绑定先 `memset(0)`，故 5 个数值字段（含 `maxTotalLen`）必须全量显式给值
- [x] 2.3 `extraResources/sherpa/worker/sherpa-worker.js` 内联等价 `buildQwenRecognizerConfig` + `ensureLoaded` 按 `modelType` 选分支；`buildKey` 纳入 qwen 四件套路径 + 全部解码参数
- [x] 2.4 `test:engines` 补 qwen3_asr 映射单测（四件套 + 全解码参数 + 空 tokens + 共享 VAD + `buildQwenParams` 默认值）——106 passed

## 3. 运行时入口泛化（D4）

- [x] 3.1 新增引擎无关入口 `getSherpaAsrRuntime`（= `getSherpaFunasrRuntime` 别名，零改类内部，最小改动）；`SherpaFunasrRuntime` 本就引擎无关，worker 依 `modelType` 选分支
- [x] 3.2 缓存 key 由 `buildKey` 按 modelType + 模型路径 + 参数生成，FunASR↔Qwen 切换自动重建、同引擎命中不重建
- [x] 3.3 funasrEngine 沿用 `getSherpaFunasrRuntime`（与别名同一单例，零行为变化）；qwenEngine 用 `getSherpaAsrRuntime`

## 4. Qwen 模型清单与下载（D5）

- [x] 4.1 新增 `main/helpers/qwenModelCatalog.ts`：`QWEN_MODELS`（默认 `qwen3-asr-0.6b` int8 tar.bz2 整包 + 体积 + `requiredFiles` 校验）、`getQwenModelDir`、`isQwenReady`、`getInstalledQwenModels`、`resolveQwenSelection`、`deleteQwenModel`
- [x] 4.2 `isQwenReady` 校验四件套齐全 **且** silero VAD 存在（复用 FunASR 的 `models/funasr/silero-vad/silero_vad.onnx`，经 `isQwenVadInstalled` 判定）
- [x] 4.3 新增 `main/helpers/qwenModelDownloader.ts`：复用 `downloadFileParallel`（断点续传/并行）+ 镜像回退（ghfast→github）+ `decompress`（bundled tarbz2）解包，落 `userData/models/qwen/<id>/`
- [x] 4.4 silero VAD 缺失时由 `QwenModelSection` 引导下载，复用 funasr 的 `downloadFunasrModel('silero-vad')`（同一文件，不重复存储）
- [x] 4.5 解包不卡 UI：新增 `download/extractArchive.ts`，~1GB tar.bz2 优先用 system tar（独立 OS 进程，主线程事件循环不阻塞）解包并按目标目录大小估算进度，失败回退 bundled decompress；UI 显示「解包中…」（修复"下载完成后软件卡住"）

## 5. 引擎适配器与注册（D6）

- [x] 5.1 新增 `main/helpers/engines/qwenParams.ts`：`max_total_len`/`max_new_tokens`/`temperature`/`top_p`/`seed` + provider/num_threads + 复用 VAD 调参，`buildQwenParams(settings)`；默认值对齐 sherpa 上游（512/128/1e-6/0.8/42）。**不接 language**：sherpa qwen3Asr 配置无 language 字段（由模型内部 prompt 处理）
- [x] 5.2 新增 `main/helpers/engines/qwenEngine.ts`（仿 `funasrEngine.ts`）：`id:'qwen'`、`requiresRuntime:true`、无 `pyEngineId`；`isAvailable`=sherpa 库已装 && `isQwenReady`；`transcribe`/`cancelActive`/`prewarm` 走 `getSherpaAsrRuntime`
- [x] 5.3 `types/engine.ts`：`TranscriptionEngine` 加 `'qwen'`
- [x] 5.4 `main/helpers/engines/registry.ts`：注册 `qwenEngineAdapter`

## 6. 任务侧接线（D7）

- [x] 6.1 `main/helpers/taskProcessor.ts`：把 `qwen` 纳入 `isRestrictiveEngine`，并发钳制（含 qwen 即 effectiveMax=1，与 funasr 共用 sherpa worker）
- [x] 6.2 IPC：模型下载/状态/删除落在 `systemInfoManager.ts`（`downloadQwenModel`/`getQwenModelStatus`/`deleteQwenModel`，删除前 `getSherpaAsrRuntime().dispose()` 释放文件锁）；`ipcEngineHandlers.ts` 加 `set-qwen-settings`（provider/numThreads）
- [x] 6.3 `systemInfoManager.ts`：`getSystemInfo` 输出 `qwenEngineInstalled`/`qwenVadInstalled`/`qwenModelsInstalled`/`qwenModelsPath`；`renderer/lib/engineModels.ts` 跨引擎就绪/分组接入 qwen

## 7. 资源中心 UI 与 i18n

- [x] 7.1 `EngineModelTab` 引擎列表加 `qwen`（紫色 waveform `EngineIcon` + 状态点/徽章）+ 右栏 `QwenPanel`（共享 sherpa 运行库管理）+ `QwenModelSection`（模型 + 共享 VAD 行）
- [x] 7.2 `QwenModelSection` 下载前 `AlertDialog` 体积二次确认（~0.95GB）；`engines.qwen.desc` 标注 CPU 友好但非实时
- [x] 7.3 任务页 `Models`/`InlineConfigBar` 透传 `qwen{Vad,Models,Engine}Installed`，`getEngineModelGroups` 仅在运行库+VAD+模型三者就绪时出现 qwen 分组
- [x] 7.4 新增 qwen i18n：`resources.json` engines.qwen.\* + `common.json` engineBadge.qwen（中英双语），过 `yarn check:i18n`

## 8. 验证与回归

- [x] 8.1 `npx tsc --noEmit -p renderer/tsconfig.json` 通过：所触 qwen/UI 文件零类型错误（剩余报错均为既有 `__tests__` 缺 jest 类型，与本次无关）
- [x] 8.2 `yarn test:engines` 通过（111 passed, 0 failed，含 qwen3_asr 配置映射 + `buildQwenParams` 默认值单测）
- [ ] 8.3 端到端冒烟：下载 sherpa 库 + qwen 0.6B 模型 → 选 qwen → 预热 → 出 SRT（段级时间戳）；进度/取消正常
- [ ] 8.4 Windows 冒烟：首个 qwen 转写不卡 0%（worker 线程，关键验收）
- [ ] 8.5 回归：faster-whisper / FunASR / whisper.cpp 行为不受影响

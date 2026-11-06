# Tasks: fix-windows-nonascii-native-paths

## 1. 根因确认（真实 Windows 探针，先于任何修复）

- [x] 1.1 新增 `.github/workflows/windows-nonascii.yml` 与 `scripts/windows-nonascii/` 探针：在含中文的目录下复现 sherpa VAD / `readWave` / `writeWave` / 降噪 / worker `detectSpeech`，以及 whisper addon 的音频解码，只报告不断言。[run 38362012250](https://github.com/buxuku/SmartSub/actions/runs/38362012250)：每一项 `[BUG REPRODUCED]` 都有对应的 `[control ok]`，VAD 在中文路径下 0 个语音段并伴随 643 行 `vad is nullptr`，ACP 为 1252
- [x] 1.2 用运行结果核对推断：whisper 的 ggml 模型与 VAD 模型路径含中文时能正常加载，只有音频解码失败。因此 whisper 只对音频做 PCM 兜底，模型路径不动

## 2. 修复

- [x] 2.1 随包模型暂存：新增 `nativeSafePath.ts`（`hasNonAscii`、`needsNativeSafe`、`stagingBaseDirs`、`stageBundledModel`、`ensureNativeSafeModelPath`）；`sherpaFunasrRuntime.ts` 的 prewarm / transcribe / detectSpeech / denoise 在交给 worker 前接入
- [x] 2.2 单测先于实现（`scripts/test-engine-units.ts`）：候选目录顺序固定、剔除含非 ASCII 项并去重、缺少环境变量时跳过、内容寻址、逐字节复用、篡改 / 截断 / 删除后重建、候选目录回退、全部失败回原路径并记 warning、超过 64 MiB 不暂存、文件名 ASCII 化、跨进程幂等、非 Windows 与 ASCII 路径不创建任何文件
- [x] 2.3 wav 读写：新增 `extraResources/sherpa/worker/wav-io.js`，接入 `sherpa-worker.js`、`tts-worker.js`、`speaker-diarization-worker.js`；`writeWave` 失败从返回 `false` 改为异常；`SMARTSUB_FORCE_JS_WAV=1` 可在任何平台强制走 JS
- [x] 2.4 新增 `scripts/test-wav-io.cjs`（22 项）：编码固定向量（与 sherpa-onnx 的 `WriteWave` 逐字节一致）、各种位深 / 声道 / `WAVE_FORMAT_EXTENSIBLE` / 跳过 `JUNK`、`LIST` 块 / 不完整尾帧 / 坏输入的可读报错、编码再解码的往返；读写分派（仅 Windows 且路径含非 ASCII，或强制开关时才走 JS，其余路径原生库不被触碰）；JS 写入失败抛错，原生返回 `false` 也不再被忽略。更新 `scripts/test-sherpa-worker.cjs` 与 `scripts/dubbing/test-language-flow.cjs` 的假 `require`
- [x] 2.5 本机另用 macOS 原生 sherpa 对拍（一次性核对，未入库）：写出的文件与原生写入器逐字节相同，读到的样本与原生读取器完全一致；Windows 上由 CI 的 `verify-sherpa` 对拍（见 3.1）
- [x] 2.6 内置 whisper 的 PCM 输入：新增 `whisperAudioInput.ts`，`addonLoader.ts` 在 `whisperAsync` 上统一接入；`prepareBuiltinChunks` 可传分块计划，`builtinEngine.ts` 对非 ASCII 路径使用 `PCM_INPUT_CHUNK_PLAN`（超过 1 小时才分、每片不超过 30 分钟）；`scripts/test-engine-units.ts` 覆盖适配条件、透传与告警、WAV 解码（只认 16 位 PCM：取第一声道、跳过奇数长度的 `LIST` 块、`data` 声明长度超出文件时按实际长度、浮点 / 8 位 / 非 RIFF / 读不到的文件返回 `null`）、分块计划
- [x] 2.7 本机用真实 whisper.cpp addon（ggml-tiny）核对（一次性核对，未入库）：同一份 16 kHz wav 以路径输入与以 `pcmf32` 输入，分段与文本一致；缓冲输入不写任何输出文件。Windows 上由 CI 的 `verify-whisper` 核对（见 3.1）
- [x] 2.8 静默失败可见：`utilityHost.ts` / `appUtilityHost.ts` 增加 `onStderrLine`；新增 `nativeFailure.ts`（`NativeStderrWatch`、`describeNullVad`、`withNonAsciiPathHint`、`collectNativePaths`）；`SherpaFunasrRuntime` 为每个 worker 建一个监视器，零结果 + 请求期间出现 `vad is nullptr` 时在 200 ms 宽限后改为带原生原因的错误，并释放持有空 VAD 的 worker（只在它仍是当前 worker 时）
- [x] 2.9 `cloneAudioPipeline.ts`：Silero VAD 失败回退能量法时补 warning 日志（原来静默吞掉）
- [x] 2.10 新增 `scripts/test-sherpa-runtime-failures.cjs`（17 项）：stderr 先于 / 晚于结果到达都能识别；真正的静音与已有识别结果不误报；只算本次请求期间新增的 `vad is nullptr`；detectSpeech 与 denoise；失败后 worker 被释放且下一次请求重建、不继承旧计数；等待期间 worker 已被替换时不误杀新 worker；非 ASCII 路径建议只在 Windows 且路径确含非 ASCII 时追加（嵌套模型路径也检查）；其他错误（ASCII 路径、非 Windows、取消、忙碌）原样传递。`scripts/crash/test-utility-host.ts` 补 4 项 stderr 行回调测试：跨块拼接 / CRLF / 空行、退出时无换行的最后一行、回调抛错不影响日志与退出处理、无换行的超长输出不无限累积
- [x] 2.11 本机端到端（一次性核对，未入库）：用真实的 `SherpaFunasrRuntime`、`sherpa-worker.js` 与 `UtilityHost`，让 VAD 模型路径指向不存在的文件，复现同样的 643 行 `vad is nullptr`，现在约 200 ms 内以带原生原因的错误结束，下一次请求在新 worker 上正常
- [x] 2.12 诊断：`diagnosticsBundle.ts` 新增 `describeRuntimePaths`，`ipcDiagnosticsHandlers.ts` 的 `appInfo()` 返回 `userDataPath` / `installPath` / `tempPath` 的 `nonAscii`、`hasSpace` 标志；`scripts/crash/test-diagnostics.ts` 覆盖中文用户名、安装目录含中文与路径缺失，并断言输出里没有路径文本

## 3. 真实 Windows 验证（GitHub Actions `windows-latest`）

- [x] 3.1 把探针扩展为断言（`verify-sherpa.mjs`、`verify-whisper.mjs`）并保留探针步骤：暂存后的 VAD / 降噪模型是 ASCII 路径上的逐字节副本并能加载；真实 `sherpa-worker.js` 在中文路径音频上得到与全 ASCII 对照相同的语音段、没有 `vad is nullptr`；JS 写出的 wav 与原生写入器逐字节相同、JS 读到的样本与原生读取器一致；写失败是异常；whisper 经 `withNativeSafeAudioInput` 以 PCM 缓冲输入，分段数与文本和 ASCII 对照一致、没有 `failed to read audio file`
- [x] 3.2 新增 `unit` 作业在 Windows 上跑 `yarn test:engines`。首次运行（[run 38366208392](https://github.com/buxuku/SmartSub/actions/runs/38366208392)）该作业失败，不是代码问题：`--ignore-scripts` 让 `node_modules/electron` 没有 `path.txt`，单测加载的 `funasrModelCatalog` 等模块在顶层 `require('electron')` 会直接抛错。本机用「去掉 `path.txt` 的 electron」复现同样的失败，设置 `ELECTRON_OVERRIDE_DIST_PATH` 后恢复；workflow 在该步骤加了这个环境变量
- [x] 3.3 [run 38366811833](https://github.com/buxuku/SmartSub/actions/runs/38366811833)（`568c2935`）三个作业全部通过：sherpa 21 项、whisper 7 项、Windows 上 `yarn test:engines`（1097 项 + sherpa worker + 17 项运行时失败 + 22 项 wav-io + Qwen scaffold）

## 4. 本机验证与文档

- [x] 4.1 `openspec validate fix-windows-nonascii-native-paths --strict` 通过
- [x] 4.2 `yarn typecheck` 通过
- [x] 4.3 相关测试通过：`test:engines`（1097 项 + sherpa worker + 17 项运行时失败 + 22 项 wav-io + Qwen scaffold）、`test:voice-clone`（193 项）、`test:crash`（21 个套件）、`test:dubbing`（318 项）、`test:speaker-diarization`（65 项 + 31 项）、`test:sherpa-json`（4 项）
- [x] 4.4 `yarn test:pro-baseline` 通过（42 条测试命令）
- [x] 4.5 `prettier --check` 覆盖本分支改动的全部文件与本目录文档

## 5. 未验证项（需要真实环境，请勿当作已验证）

- [ ] 5.1 **真实的中文代码页（936）与真实的中文用户名机器。** CI 的 ACP 是 1252，与 936 同属「窄字符 API 按非 UTF-8 代码页解码」，失败机制相同，但 936 没有直接跑过。手测清单（中文用户名、默认安装目录、不设统一存储目录）：
  - 声音克隆：导入素材，分析阶段能得到可采样的片段（日志里不再有 `vad is nullptr`）
  - 声音克隆：创建音色并能播放试听样本（参考音频在 `userData/voiceClones/<id>/ref.wav`，路径含中文）
  - 配音：合成后产出 wav（会话目录在 `userData/dubbing-sessions/<id>/`，路径含中文）
  - 内置 whisper 转写：临时目录用默认值（含中文），产出非空字幕，日志里有 `whisper input: …feeding … PCM samples instead`
  - 本地 ASR（FunASR 等）与降噪：能完成，日志里有 `native-safe: staged …`
  - 诊断包：应用信息里 `tempPath.nonAscii`、`userDataPath.nonAscii` 为 `true`
  - 故意把说话人分离或 TTS 的模型放进中文目录，确认界面上看到的是带「统一存储目录」建议的错误，而不是 `Please check your config!`
- [ ] 5.2 PCM 兜底路径的内存峰值：addon 会把缓冲拷贝数份（1 小时约 230 MB 一份），分块阈值已收紧到 1 小时，但数小时音频的实际峰值没有测过
- [ ] 5.3 faster-whisper（Python / CTranslate2）与 ffmpeg 字幕烧录（libass）在含非 ASCII 路径下的行为：没有验证，也没有改动
- [ ] 5.4 说话人分离与 TTS 的 GB 级用户模型只做了提示，没有自动暂存；提示文案没有在界面里目测
- [ ] 5.5 预热（`load`）阶段的失败只写 stderr 日志、没有对应的请求，不会提示用户；本次没有改动。暂存成功时不会走到这里
- [ ] 5.6 请反馈用户补充 `vad is nullptr` 之前的几行日志，并确认他有没有设置过统一存储目录，用来确认他那台机器的根因就是路径（用户名含中文已确认，但尚未拿到他机器上的原生原因行）

## 6. 后续（不在本次范围）

- [ ] 6.1 向上游 k2-fsa/sherpa-onnx 反馈：Node addon 的 `vad.cc` 创建 VAD 失败后不判空也不抛错；`writeWave` 失败只返回 `false`
- [ ] 6.2 中文用户名时首次引导自动预填英文统一存储目录（本次只把大模型目录的报错说清楚，仍沿用现有 `storageRoot` 引导）
- [ ] 6.3 清理模型升级后遗留的旧暂存副本（每个版本约 2.3 MB，目前不清理）
- [ ] 6.4 用户文档补一条「Windows 用户名或安装目录含中文」的说明与统一存储目录的设置方法

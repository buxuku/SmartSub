## Why

一位 Windows 用户（用户名含中文）反馈声音克隆无法使用：日志里反复出现 `asr worker stderr: vad is nullptr`，分析阶段拿不到任何语音段。

根因不在声音克隆，而在**原生库打不开含非 ASCII 字符的路径**。sherpa-onnx、whisper.cpp 的音频解码在 C++ 层用窄字符 API（`fopen`、`std::ifstream`、`CreateFileA`）打开文件，Node 传进去的是 UTF-8 字节；系统代码页不是 UTF-8（中文版 Windows 默认 GBK / 936）时，这些字节被当成本地代码页解码，路径变成另一个不存在的名字。用户名含中文时，默认安装目录、`userData`、`%TEMP%` 全部落在这类路径下，随包的 VAD / 降噪模型、抽出的 16 kHz wav 都在其中。

**这不是推断，在真实 Windows 上复现过。** GitHub Actions `windows-latest`（Windows 10.0.26100、Node 22.14.0）上，把同一份素材放进 `…\中文用户-测试\` 目录（探针 [run 38362012250](https://github.com/buxuku/SmartSub/actions/runs/38362012250)，修复之前）：

| 调用                                    | ASCII 路径（对照） | 含中文路径                                                                                                                                        |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| sherpa Silero VAD 构造                  | 检出 5 个语音段    | **不抛错**，返回空句柄；stderr 先有 `Silero vad model file '…' does not exist`、`Errors in config`，之后 643 行 `vad is nullptr`，结果 0 个语音段 |
| sherpa `readWave`                       | 正常               | 抛 `Failed to read '…'`                                                                                                                           |
| sherpa `writeWave`                      | 返回 true          | 返回 `false`（原来没有任何调用方检查，产物悄悄缺失）                                                                                              |
| sherpa 降噪（gtcrn）构造                | 正常               | 只抛 `Please check your config!`，原因只在 stderr                                                                                                 |
| whisper.cpp addon 解码音频              | 2 段               | **Promise 照常 resolve，0 段**，stderr 一行 `failed to read audio file`——整个任务悄悄变成空字幕                                                   |
| whisper.cpp 的 ggml 模型 / VAD 模型路径 | 正常               | 正常（只有音频解码受影响）                                                                                                                        |

用户这条日志就是第一行的结果：VAD 创建失败后静默，`vad is nullptr` 刷屏。声音克隆分析的 `detectSpeechSegmentsMs` 只在 VAD 抛错时才回退到能量法，而这里是「成功返回 0 个语音段」，于是被当成素材里没有语音，分析得不到可采样的片段。更糟的是失败被缓存：空 VAD 留在常驻 worker 里，之后每次请求都继续失败，直到重启应用。

上表只列实测过的调用。识别器、TTS、说话人分离的构造函数与降噪走同一类路径（只抛 `Please check your config!`），按同类失败处理，但没有逐个在 Windows 上实测。

runner 的 ANSI 代码页是 1252，不是中文系统的 936，但这类失败只取决于「代码页不是 UTF-8」，两者同类；这一点在文档与脚本输出里都如实标注，真正的 936 环境没有验证过（见 tasks 5.x）。

已有的 `unified-storage-root` 只覆盖「用户自己选的目录」（选到含中文的目录会被拒绝，默认存储位置含中文会提示），管不到用户**无法改**的那部分：安装目录里的随包模型、系统临时目录里的音频。所以必须在软件层面兜住。

## What Changes

只在 **`win32` 且路径含非 ASCII 字符** 时介入；ASCII 用户与其他平台的行为不变，所有兜底在失败时都回退为原路径，不会比不处理更差。按文件性质分三类：

- **随包小模型（Silero VAD ≈ 1.8 MB、gtcrn 降噪 ≈ 0.5 MB）→ 暂存到 ASCII 目录。** 新增 `nativeSafePath.ts`：内容寻址（sha1）复制到 `<base>/<sha1 前 16 位>/<ASCII 文件名>`，`base` 按 `userData` → `%ProgramData%\SmartSub` → `%PUBLIC%\SmartSub` → `%SystemDrive%\SmartSub` 依次尝试，自身含非 ASCII 的候选被剔除；复用前逐字节校验，每进程缓存，失败回退原路径并记 warning。`SherpaFunasrRuntime` 的 prewarm / transcribe / detectSpeech / denoise 在交给 worker 前接入
- **用户音频 → 不复制，改在 JS 里读写。**
  - sherpa worker（sherpa / tts / speaker-diarization）：新增 `extraResources/sherpa/worker/wav-io.js`，含非 ASCII 路径时由 JS 读写 wav，编解码口径与原生一致；`writeWave` 失败从此是异常，不再静默返回 `false`
  - 内置 whisper.cpp：新增 `whisperAudioInput.ts`，含非 ASCII 的音频路径由 JS 解码，以 `pcmf32` + 空串 `fname_inp` 交给 addon；在 `addonLoader.ts` 的 `whisperAsync` 上统一接入，内置转写（单次与分块）与声音克隆的参考音频转写都覆盖。addon 会把缓冲拷贝数份，所以这条兜底路径的分块阈值从 4 小时降到 1 小时
- **GB 级用户模型（说话人分离、TTS）→ 不搬，只给提示。** 原生库因打不开文件而失败，且涉及非 ASCII 路径时，错误信息追加中英文建议：在设置里把统一存储目录设为纯英文路径并重新下载 / 导入模型；应用装在含中文目录时重装
- **静默失败变成可见的错误。** `utilityHost` 新增可选 `onStderrLine`；`SherpaFunasrRuntime` 为每个 worker 记录 `vad is nullptr` 与原生给出的原因，请求以零个语音段结束且期间出现过 `vad is nullptr` 时，改为带原生原因的错误，并释放持有空 VAD 的 worker（下一次请求在新 worker 上重试）。声音克隆在 Silero VAD 失败回退到能量法时补 warning 日志（原来静默吞掉）
- **诊断包标明路径是否会出问题。** `appInfo()` 增加 `userDataPath` / `installPath` / `tempPath` 的 `nonAscii`、`hasSpace` 标志，不导出路径文本
- **CI 在真实 Windows 上守护。** 新增 `windows-nonascii.yml`：在含中文的目录下复现原生限制（探针，只报告），并断言上述对策有效（暂存、JS wav 读写与原生逐字节一致、whisper PCM 输入与 ASCII 对照结果一致），同时在 Windows 上跑 `yarn test:engines`
- 不在本次范围：
  - 修改 `unified-storage-root` 的中文路径校验或默认值：那是「让用户自己别选中文路径」，与本次互补，不冲突
  - GB 级用户模型的自动暂存 / 迁移（体积与磁盘占用不可接受，只提示）
  - faster-whisper（Python / CTranslate2）、ffmpeg 字幕烧录（libass）在含非 ASCII 路径下的行为：没有验证，也没有改动（见 tasks 5.x）
  - 全局 UTF-8 清单（`activeCodePage`）与 NTFS 联接点：见 design D3

## Capabilities

### New Capabilities

- `native-path-compat`: 原生库在 Windows 非 ASCII 路径下的兼容：随包模型暂存、sherpa worker 的 wav 读写、内置 whisper 的 PCM 输入、静默失败可见、路径诊断标志

### Modified Capabilities

（无）

## Impact

- 主进程：新增 `main/helpers/sherpaOnnx/nativeSafePath.ts`、`nativeFailure.ts`，`main/helpers/engines/whisperAudioInput.ts`；修改 `sherpaFunasrRuntime.ts`、`main/helpers/crash/utilityHost.ts`、`appUtilityHost.ts`、`addonLoader.ts`、`audioProcessor.ts`（`prepareBuiltinChunks` 可传分块计划）、`engines/builtinEngine.ts`、`voiceClone/cloneAudioPipeline.ts`、`crash/diagnosticsBundle.ts`、`ipcDiagnosticsHandlers.ts`
- worker：新增 `extraResources/sherpa/worker/wav-io.js`，修改 `sherpa-worker.js`、`tts-worker.js`、`speaker-diarization-worker.js`
- 渲染层与 IPC 通道：无变化（诊断 `appInfo` 的返回值多了三个字段）
- 测试：`scripts/test-engine-units.ts`（路径逻辑、暂存、PCM 适配、静默失败）、新增 `scripts/test-wav-io.cjs`、`scripts/test-sherpa-runtime-failures.cjs`，扩展 `test-sherpa-worker.cjs`、`crash/test-utility-host.ts`、`crash/test-diagnostics.ts`，全部并入 `yarn test:engines` / `test:crash`
- CI：新增 `.github/workflows/windows-nonascii.yml` 与 `scripts/windows-nonascii/`
- 磁盘：含非 ASCII 路径的 Windows 用户会多出 `native-models/` 下约 2.3 MB 的暂存副本；ASCII 用户无变化
- 无新增第三方依赖；无数据迁移，行为变化即时生效，已保存的设置不受影响

# 评估:sherpa-onnx-node + SenseVoice 作为转写引擎备选

> 状态:调研结论(未做本地 PoC)
> 日期:2026-06-10
> 关联:`python-engine/`(faster-whisper sidecar)、`main/helpers/transcriptionEngine.ts`(引擎路由)

## 1. 评估背景

SmartSub 当前已有三条转写路径:

| 路径             | 形态                                 | 状态                                         |
| ---------------- | ------------------------------------ | -------------------------------------------- |
| 内置 whisper.cpp | N-API addon + ggml 模型              | 已上线(默认)                                 |
| faster-whisper   | Python sidecar(PyInstaller 冻结分发) | 已落地(`transcriptionEngine: fasterWhisper`) |
| 本地命令行       | 用户自装 whisper 兼容 CLI            | 已上线                                       |

本评估回答:**sherpa-onnx-node(免 Python 的现成 npm 原生扩展)+ SenseVoice(FunASR 系中文模型)能否/值不值得作为第四个引擎选项**,尤其针对"中文识别质量与速度"这一诉求。

## 2. sherpa-onnx-node 是什么

- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)(Next-gen Kaldi 团队)的 Node.js 原生扩展封装,底层是 C++ + onnxruntime,**无需任何 Python 运行时**。
- npm 包 [`sherpa-onnx-node`](https://www.npmjs.com/package/sherpa-onnx-node):Apache-2.0,周下载约 1.4 万,发版频繁(随主仓库版本走)。
- 预编译平台包齐全:`darwin-x64` / `darwin-arm64` / `linux-x64` / `linux-arm64` / `win32-x64`,**覆盖 SmartSub 全部目标平台(含 macOS arm64)**。
- 基于 N-API(node-addon-api),ABI 稳定,理论上无需针对 Electron 重编译(与现有 whisper.cpp addon 的集成模式同构)。
- 能力面很宽:离线/流式 ASR、VAD(silero)、说话人分离、TTS、标点恢复等。ASR 支持的模型族:SenseVoice、Paraformer(FunASR 系)、Zipformer、Whisper(onnx 导出版)、Moonshine、FireRedASR 等。

## 3. SenseVoice 模型(评估主角)

| 维度     | 数据                                                                  | 来源             |
| -------- | --------------------------------------------------------------------- | ---------------- |
| 模型     | SenseVoiceSmall(阿里 FunAudioLLM,~234M 参数,CTC encoder-only)         | HF 模型卡        |
| 语言     | **中文、英文、日语、韩语、粤语**(对中文方言鲁棒)                      | sherpa 官方文档  |
| 体积     | int8 onnx 单文件 **约 228–239MB** + tokens ~309KB                     | HF 文件清单      |
| 许可     | 模型及 onnx 导出均标注 Apache-2.0(集成前建议复核 ModelScope 原始条款) | HF 模型卡        |
| 附加能力 | 语种识别、情感识别、音频事件检测、ITN(逆文本正则化)                   | FunAudioLLM 论文 |
| 时间戳   | 输出 token 级时间戳;字幕分段一般配合内置 silero VAD 做段边界          | sherpa-onnx 示例 |

### 性能(官方 RK3588 嵌入式 CPU 基准,int8 单线程)

| CPU                    | 1 线程 RTF | 4 线程 RTF |
| ---------------------- | ---------- | ---------- |
| Cortex-A55(低端)       | 0.436      | 0.175      |
| Cortex-A76(中端手机级) | 0.099      | 0.049      |

嵌入式 A76 单线程即可 10 倍实时;桌面级 x86 / Apple Silicon 预期 RTF 在 0.02–0.05 量级,即 **1 小时音频约 1–3 分钟,纯 CPU,无需任何 GPU 依赖**。这与 FunASR 官方"SenseVoice-Small 比 Whisper-large 快约 15 倍"的口径一致。

## 4. 与现有两个内置引擎对比

| 维度          | whisper.cpp(现内置)                 | faster-whisper(已落地)        | sherpa-onnx + SenseVoice             |
| ------------- | ----------------------------------- | ----------------------------- | ------------------------------------ |
| 运行时        | N-API addon(C++)                    | Python sidecar,冻结产物 167MB | N-API addon(C++),npm 直装            |
| 中文质量      | 一般(Whisper 系通病:标点/幻觉/方言) | 同 Whisper 系                 | **强**(中文数据训练,带标点/ITN)      |
| 中文速度(CPU) | 慢(large 不可用级)                  | 中(CT2 int8 加速)             | **极快**(15x Whisper-large 量级)     |
| 多语言覆盖    | ~100 语言                           | ~100 语言                     | **仅 zh/en/ja/ko/yue**               |
| 词级时间戳    | 支持                                | 支持                          | token 级(需 VAD 辅助分段)            |
| GPU 加速      | CUDA / Core ML                      | CUDA(cuBLAS/cuDNN)            | 弱(node 包以 CPU 为主,但 CPU 已够快) |
| 翻译成英文    | 支持(Whisper translate)             | 支持                          | 不支持                               |
| 模型分发      | ggml 手动下载(已有 UI)              | HF 自动下载到 userData        | 一次性下载 ~230MB tar.bz2            |
| 安装包增量    | 0(已内置)                           | ~70MB(冻结引擎 tar.gz)        | **~15–25MB**(addon + onnxruntime)    |
| 维护成本      | 自编译 addon(已有 CI)               | PyInstaller CI(已建)          | **npm 升级即可,最低**                |

关键互补关系:**SenseVoice 解决的是"中文场景的质量+速度",Whisper 系解决的是"语言覆盖广度"。两者不是替代关系。**

## 5. 集成到 SmartSub 的技术方案(若立项)

现有 `transcriptionEngine` 三值路由(`builtin | fasterWhisper | localCli`)直接扩展第四值 `senseVoice`:

1. **依赖**:`npm i sherpa-onnx-node`(主进程依赖,随应用打包)。
2. **打包**:平台子包(如 `sherpa-onnx-darwin-arm64`)含 `.dylib/.so/.dll`,需:
   - `asarUnpack` 加入 `node_modules/sherpa-onnx-*`(与 ffmpeg-static 现行做法一致);
   - macOS/Linux 需保证动态库可被找到(官方要求 `DYLD_LIBRARY_PATH`/`LD_LIBRARY_PATH`,Electron 主进程可在 spawn 前注入,或用 `process.env` 在 app 启动早期设置);
   - electron-builder 各平台仅打当前平台子包(`files` 过滤其余平台,避免 5 平台库全量入包)。
3. **模型分发**:复用 `modelsControl` 下载页模式,新增 SenseVoice 条目(GitHub release 的 tar.bz2,~230MB,解压到 `modelsPath/sense-voice/`),不随安装包分发。
4. **字幕链路**:`generateSubtitleWithSenseVoice`:
   - 16kHz mono wav(现有 `audioProcessor` 产物直接可用);
   - sherpa-onnx 内置 silero VAD 切段 → 每段 `OfflineRecognizer` 识别 → 段边界作为字幕时间轴(官方有 `vad + sense_voice` 完整示例);
   - 进度按"已处理时长/总时长"映射到 `taskProgressChange`,与 faster-whisper 分支同构。
5. **UI**:引擎下拉新增一项;选中时模型下拉仅显示 SenseVoice(语言下拉限制为 zh/en/ja/ko/yue + auto)。

预估工作量:**3–5 人日**(含模型下载 UI、双语言限制逻辑、三平台冒烟)。无需新 CI 基础设施。

## 6. 风险与局限

1. **语言硬边界**:仅 5 种语言。选了 SenseVoice 引擎后,其他语言任务必须回落到 Whisper 系——路由与 UI 必须把这个约束表达清楚,否则用户困惑。
2. **时间戳粒度**:CTC token 时间戳偏"字级",长句断行需依赖 VAD 段 + 标点二次切分,字幕观感需要 PoC 实测调优(这是最大的产品化不确定点)。
3. **动态库加载**:Electron 打包后 `DYLD_LIBRARY_PATH` 注入在 macOS SIP 下有坑(官方 FAQ 提到可能需要 `install_name_tool` 修补 rpath),需要在打包冒烟中重点验证。
4. **GPU**:node 包基本 CPU-only。对 SenseVoice 无所谓(够快),但意味着它不能顺带跑 Whisper-large onnx(慢),**不能替代 faster-whisper 的大模型场景**。
5. **许可复核**:sherpa-onnx 本体 Apache-2.0 无虞;SenseVoiceSmall 原始权重在 ModelScope 的条款需在正式分发模型下载链接前复核一次。

## 7. 结论与建议

- **值得做,但定位是"中文场景增强",不是替代**:SenseVoice 在中文/中英混合视频上预期同时拿到"质量更好 + 快一个量级 + 零 GPU 依赖"三个收益,而这恰是 SmartSub 中文用户的主场景。
- **优先级建议**:排在 faster-whisper 产品化收尾(打包分发已就绪)之后,作为独立 PoC 立项;先验证两点——①Electron 打包后的动态库加载,②VAD 分段字幕的断句观感。两点都过,再做完整 UI 接入。
- **不建议**:用 sherpa-onnx 的 Whisper onnx 路径替代 faster-whisper(CPU 跑大模型不现实,GPU 支持弱);删减现有 whisper.cpp(语言覆盖与词级时间戳仍是基本盘)。

## 参考

- sherpa-onnx 仓库:https://github.com/k2-fsa/sherpa-onnx
- sherpa-onnx-node(npm):https://www.npmjs.com/package/sherpa-onnx-node
- Node 集成示例(VAD + SenseVoice):https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md
- SenseVoice 预训练模型与 RTF 基准:https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html
- FunAudioLLM/SenseVoice:https://github.com/FunAudioLLM/SenseVoice

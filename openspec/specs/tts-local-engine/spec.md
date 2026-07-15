# Spec: tts-local-engine

## Purpose

本地 sherpa-onnx 语音合成引擎：独立常驻 TTS worker 进程池(与 ASR worker 分进程、崩溃隔离、1–3 路并行)、统一 16-bit PCM wav 单段合成合同(text/voice/speed)、kokoro 与 vits-zh 模型目录、下载(ghproxy→github)与手动导入管理。

## Requirements

### Requirement: 独立常驻 TTS worker

系统 SHALL 以**独立常驻子进程池**（Electron `utilityProcess`，池上限 3、默认 1、按需求扩展）运行本地 TTS 推理(复用内置 sherpa-onnx v1.13.2 的 TTS C API,不改动 native 构建链),消息协议至少包含 `load / synthesize / cancel / dispose`;TTS worker MUST 与 ASR worker 分进程,任一方崩溃不影响另一方。合成请求 SHALL 派发到在途最少的池成员,`cancel` MUST 路由到请求所属进程;**native 层崩溃（onnxruntime abort/段错误等）MUST NOT 影响主进程与池内其余进程**：主进程收 exit 后仅该进程在途请求以可读错误 reject、该成员移出池,下次请求自动补员;批量合成结束后 SHALL 回收多余空闲进程（避免多份模型常驻内存）。worker 的 stderr SHALL 进应用日志（崩溃前输出是关键诊断线索）。worker 通信 SHALL 兼容纯 node `worker_threads` 运行（PoC/单测脚本无 Electron 依赖）。模型配置构建 MUST 收敛到单一纯函数模块,由 worker 直接 require,不得在 worker 内维护第二份内联配置。

#### Scenario: worker 崩溃隔离

- **WHEN** 池中某个 TTS worker 进程因 native 层错误异常退出
- **THEN** 主进程、渲染窗口与池内其余 worker 不受影响,仅该进程在途合成请求返回可行动错误,下次合成请求自动补员恢复执行

#### Scenario: 模型实例缓存

- **WHEN** 连续多次以相同模型参数调用 synthesize
- **THEN** 每个池成员内模型只加载一次(实例按参数缓存),后续调用不重复初始化

#### Scenario: 并行合成提速

- **WHEN** 用户把本地并行合成设为 2 并批量合成多行
- **THEN** 两个 worker 进程同时推理,总耗时显著低于串行;批量结束后池收缩回 1,内存占用回落

#### Scenario: 脚本运行时兼容

- **WHEN** PoC/冒烟脚本以纯 node `worker_threads` 加载同一 worker 文件
- **THEN** 消息协议行为与应用内 utilityProcess 一致,脚本无需 Electron 环境

### Requirement: 单段合成合同

本地引擎 SHALL 实现统一合成合同:输入 `text / voice / speed(1.0=原速) / outWavPath / signal`,输出 16-bit PCM wav 文件落盘到 `outWavPath`。speed 参数 MUST 实际生效(speed>1 时输出时长相应缩短),供对齐引擎做合成期语速预控制。

#### Scenario: 单句合成

- **WHEN** 以 kokoro 模型、有效 voice、speed=1.0 合成一句文本
- **THEN** `outWavPath` 生成可播放的 16-bit PCM wav

#### Scenario: speed 生效

- **WHEN** 同一文本分别以 speed=1.0 与 speed=1.2 合成
- **THEN** speed=1.2 的输出 wav 时长明显短于 speed=1.0(缩短幅度接近 1/1.2)

#### Scenario: 合成中取消

- **WHEN** synthesize 进行中 signal 被 abort
- **THEN** 合成中止并抛出取消语义,不留下完整假象的半成品文件

### Requirement: v1 模型目录

模型目录 SHALL 至少收录 kokoro 多语模型(zh/en 等多语,102+ 音色)、vits-zh 中文补充模型与 zipvoice-distill 双语克隆模型(zh/en,零样本克隆、无内置音色),每个条目声明:模型 id、展示名、语言范围、音色列表(id + 展示名;克隆模型为空列表并以 cloneOnly 标记)、下载体积、解包后目录结构。条目 SHALL 支持声明附加独立工件(`extraFiles`,如 zipvoice 的 vocos vocoder 位于独立 release 路径),附加工件 MUST 随整包下载流程一并获取并计入安装判定(`requiredFiles`)。

#### Scenario: 目录可枚举

- **WHEN** 渲染进程请求 TTS 模型目录
- **THEN** 返回含 kokoro、vits-zh 与 zipvoice 的条目,每条含语言与音色元数据(zipvoice 标记 cloneOnly),供 UI 渲染下载卡片与 voice 下拉

#### Scenario: 附加工件一并下载

- **WHEN** 用户下载 zipvoice 模型
- **THEN** 整包(encoder/decoder/tokens 等)与 vocoder 单文件均下载就位,进度合并推送于同一 `tts:<id>` key,缺任一工件不判定为已安装

### Requirement: 模型下载与存储

模型下载 SHALL 沿用现有下载器形制:release 整包下载 + 解包进度 + `downloadProgress`/`modelDownloadDetail` 事件,进度 key 为 `tts:<模型id>`;下载源顺序 MUST 为 `ghproxy → github`(kokoro/vits 无 ModelScope 镜像、HF 镜像 401);模型存储于 `userData/models/tts`,可被 `settings.ttsModelsPath` 覆盖;MUST 提供手动导入入口作为下载失败的兜底。

#### Scenario: 正常下载

- **WHEN** 用户在「引擎与模型」页点击下载 kokoro
- **THEN** 按源顺序下载整包、解包到模型目录,进度事件以 `tts:kokoro…` key 推送,完成后模型状态变为「已就绪」

#### Scenario: 手动导入兜底

- **WHEN** 用户下载失败后选择手动导入已解包的模型目录
- **THEN** 系统校验目录结构后将模型登记为「已就绪」,与下载安装等效

### Requirement: 零样本克隆合成（zipvoice）

本地引擎 SHALL 支持 zipvoice 零样本克隆合成：worker `synthesize` 消息可携 `generationConfig{refWavPath, refText, numSteps}`，worker 内 MUST 以 `readWave` 读取参考音频并按路径缓存（同音色多行合成不重复读盘；缓存有上限、dispose 时清空），连同参考文本经 sherpa `GenerationConfig`（referenceAudio/referenceSampleRate/referenceText/numSteps）走 WithConfig 生成 API；`numSteps` 默认 4，**SHALL 支持质量档位透传（标准 = 4 / 高 = 8，实测 RTF 0.44 → 0.91），批量合成、单行重生成与试听 MUST 使用同一档位来源**。zipvoice 的 `speedControl` 能力 MUST 声明为 `'none'`（实测 speed 参数非线性，不可用于对齐预控制），行级时长收敛走 atempo 后处理分支；用户整体语速仍 SHALL 经 generationConfig.speed 透传生效。

#### Scenario: 克隆合成出 wav

- **WHEN** 以 zipvoice 模型、有效参考音频与精确参考文本 synthesize 一句中文
- **THEN** `outWavPath` 生成 24kHz 16-bit PCM wav，音色与参考音频说话人相似

#### Scenario: 参考音频缓存

- **WHEN** 同一克隆音色连续合成多行
- **THEN** 参考音频只读盘一次（路径缓存命中），后续行不重复读取

#### Scenario: 对齐走后处理分支

- **WHEN** 对齐引擎处理 zipvoice 合成且某行需要 1.3x 压缩
- **THEN** 该行按原速合成后经 atempo 变速对齐，不向引擎传递对齐用 speed 预控制参数

#### Scenario: 质量档位生效

- **WHEN** 用户在工作台把克隆质量切为「高」并单行重生成
- **THEN** 该行以 numSteps=8 合成（耗时约两倍），试听与批量合成同样采用该档位

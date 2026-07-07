# Spec: tts-local-engine

## Purpose

本地 sherpa-onnx 语音合成引擎：独立常驻 TTS worker(与 ASR worker 分进程、崩溃隔离)、统一 16-bit PCM wav 单段合成合同(text/voice/speed)、kokoro 与 vits-zh 模型目录、下载(ghproxy→github)与手动导入管理。

## Requirements

### Requirement: 独立常驻 TTS worker

系统 SHALL 以独立常驻子进程运行本地 TTS 推理(复用内置 sherpa-onnx v1.13.2 的 TTS C API,不改动 native 构建链),消息协议至少包含 `load / synthesize / cancel / dispose`;TTS worker MUST 与 ASR worker 分进程,任一方崩溃不影响另一方。模型配置构建 MUST 收敛到单一纯函数模块,由 worker 直接 require,不得在 worker 内维护第二份内联配置。

#### Scenario: worker 崩溃隔离

- **WHEN** TTS worker 进程异常退出
- **THEN** ASR 功能不受影响,下次合成请求自动重建 TTS worker 并返回可行动错误或恢复执行

#### Scenario: 模型实例缓存

- **WHEN** 连续多次以相同模型参数调用 synthesize
- **THEN** 模型只加载一次(实例按参数缓存),后续调用不重复初始化

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

模型目录 SHALL 至少收录 kokoro 多语模型(zh/en 等多语,102+ 音色)与 vits-zh 中文补充模型,每个条目声明:模型 id、展示名、语言范围、音色列表(id + 展示名)、下载体积、解包后目录结构。

#### Scenario: 目录可枚举

- **WHEN** 渲染进程请求 TTS 模型目录
- **THEN** 返回含 kokoro 与 vits-zh 的条目,每条含语言与音色元数据,供 UI 渲染下载卡片与 voice 下拉

### Requirement: 模型下载与存储

模型下载 SHALL 沿用现有下载器形制:release 整包下载 + 解包进度 + `downloadProgress`/`modelDownloadDetail` 事件,进度 key 为 `tts:<模型id>`;下载源顺序 MUST 为 `ghproxy → github`(kokoro/vits 无 ModelScope 镜像、HF 镜像 401);模型存储于 `userData/models/tts`,可被 `settings.ttsModelsPath` 覆盖;MUST 提供手动导入入口作为下载失败的兜底。

#### Scenario: 正常下载

- **WHEN** 用户在「引擎与模型」页点击下载 kokoro
- **THEN** 按源顺序下载整包、解包到模型目录,进度事件以 `tts:kokoro…` key 推送,完成后模型状态变为「已就绪」

#### Scenario: 手动导入兜底

- **WHEN** 用户下载失败后选择手动导入已解包的模型目录
- **THEN** 系统校验目录结构后将模型登记为「已就绪」,与下载安装等效

## ADDED Requirements

### Requirement: 零样本克隆合成（zipvoice）

本地引擎 SHALL 支持 zipvoice 零样本克隆合成：worker `synthesize` 消息可携 `generationConfig{refWavPath, refText, numSteps}`，worker 内 MUST 以 `readWave` 读取参考音频并按路径缓存（同音色多行合成不重复读盘；缓存有上限、dispose 时清空），连同参考文本经 sherpa `GenerationConfig`（referenceAudio/referenceSampleRate/referenceText/numSteps）走 WithConfig 生成 API；`numSteps` 默认 4。zipvoice 的 `speedControl` 能力 MUST 声明为 `'none'`（实测 speed 参数非线性，不可用于对齐预控制），行级时长收敛走 atempo 后处理分支；用户整体语速仍 SHALL 经 generationConfig.speed 透传生效。

#### Scenario: 克隆合成出 wav

- **WHEN** 以 zipvoice 模型、有效参考音频与精确参考文本 synthesize 一句中文
- **THEN** `outWavPath` 生成 24kHz 16-bit PCM wav，音色与参考音频说话人相似

#### Scenario: 参考音频缓存

- **WHEN** 同一克隆音色连续合成多行
- **THEN** 参考音频只读盘一次（路径缓存命中），后续行不重复读取

#### Scenario: 对齐走后处理分支

- **WHEN** 对齐引擎处理 zipvoice 合成且某行需要 1.3x 压缩
- **THEN** 该行按原速合成后经 atempo 变速对齐，不向引擎传递对齐用 speed 预控制参数

## MODIFIED Requirements

### Requirement: v1 模型目录

模型目录 SHALL 至少收录 kokoro 多语模型(zh/en 等多语,102+ 音色)、vits-zh 中文补充模型与 zipvoice-distill 双语克隆模型(zh/en,零样本克隆、无内置音色),每个条目声明:模型 id、展示名、语言范围、音色列表(id + 展示名;克隆模型为空列表并以 cloneOnly 标记)、下载体积、解包后目录结构。条目 SHALL 支持声明附加独立工件(`extraFiles`,如 zipvoice 的 vocos vocoder 位于独立 release 路径),附加工件 MUST 随整包下载流程一并获取并计入安装判定(`requiredFiles`)。

#### Scenario: 目录可枚举

- **WHEN** 渲染进程请求 TTS 模型目录
- **THEN** 返回含 kokoro、vits-zh 与 zipvoice 的条目,每条含语言与音色元数据(zipvoice 标记 cloneOnly),供 UI 渲染下载卡片与 voice 下拉

#### Scenario: 附加工件一并下载

- **WHEN** 用户下载 zipvoice 模型
- **THEN** 整包(encoder/decoder/tokens 等)与 vocoder 单文件均下载就位,进度合并推送于同一 `tts:<id>` key,缺任一工件不判定为已安装

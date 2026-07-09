## MODIFIED Requirements

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

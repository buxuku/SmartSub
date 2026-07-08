## ADDED Requirements

### Requirement: 多轨混合导出

当对齐规划包含多个轨道(overlapMode = mix 且存在重叠行)时,导出 SHALL 按轨道分组逐轨 PCM 拼接(每轨补齐到统一总时长),再以 `amix` 将各轨混合为单条配音轨,混合 MUST 施加限幅(防人声叠加削波),输出保持 16-bit PCM wav 供后续背景音/输出形态路径复用;混流封装 MUST 走既有取消模式(AbortSignal + 半成品清理)。规划仅含单轨时 MUST 跳过混流步骤,与顺延模式产物路径一致。

#### Scenario: 重叠行同时发声

- **WHEN** 两条时间交叠的 cue 以 mix 模式完成合成并导出
- **THEN** 产物在重叠时段同时可闻两条配音,各自起点等于原字幕 start,无相互顺延

#### Scenario: 单轨规划零额外开销

- **WHEN** overlapMode = mix 但字幕无任何重叠行
- **THEN** 导出不发起 amix 混流,产物与顺延模式逐字节同路径产出

#### Scenario: 混流中途取消

- **WHEN** 用户在多轨混流阶段取消导出
- **THEN** ffmpeg 进程被中止、半成品输出被清理,任务以取消语义结束

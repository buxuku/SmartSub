## MODIFIED Requirements

### Requirement: 成品命名与容器

成品输出 SHALL 命名为 `<原文件名>-final.<ext>`（已存在时防覆盖递增），容器沿用源视频扩展名；软封字幕或双轨参与时 MUST 输出 mkv。源视频为 WebM/Ogg（`.webm`、`.ogv`、`.ogg`）时容器 MUST 改用 mp4——硬烧写入的 H.264 与配音写入的 AAC 在这些容器里写不进去；软封字幕或双轨参与时仍为 mkv。

#### Scenario: 防覆盖递增

- **WHEN** 同一文件第二次跑合成阶段且上次成品仍在
- **THEN** 新成品命名为 `<原名>-final-2.<ext>`，不覆盖旧成品

#### Scenario: WebM 源硬烧成品为 MP4

- **WHEN** 对 `clip.webm` 运行合成阶段（硬烧字幕）
- **THEN** 成品命名为 `clip-final.mp4`，而不是 `clip-final.webm`

#### Scenario: WebM 源软封字幕仍为 mkv

- **WHEN** 对 `clip.webm` 运行合成阶段且字幕模式为软封
- **THEN** 成品命名为 `clip-final.mkv`

#### Scenario: 其它源扩展名不变

- **WHEN** 对 `clip.mp4` 运行合成阶段（硬烧字幕）
- **THEN** 成品命名为 `clip-final.mp4`，与引入本例外前一致

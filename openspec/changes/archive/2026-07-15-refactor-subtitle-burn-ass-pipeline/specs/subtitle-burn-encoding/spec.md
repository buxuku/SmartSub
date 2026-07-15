# subtitle-burn-encoding Spec Delta

## ADDED Requirements

### Requirement: Explicit video encoder and preset for hardcode output

硬字幕烧录 SHALL 显式指定视频编码器（`-c:v libx264`）与编码 preset（`-preset medium`），不依赖 ffmpeg 按输出容器的隐式默认，保证不同 ffmpeg 版本下编码行为可预期、可追溯（日志中可见完整参数）。

#### Scenario: 烧录命令包含显式编码参数

- **WHEN** 用户执行硬字幕烧录
- **THEN** 生成的 ffmpeg 命令显式包含 `-c:v libx264` 与 `-preset medium`，且日志记录完整命令

#### Scenario: 软字幕封装不受影响

- **WHEN** 用户选择软字幕封装（softmux）输出
- **THEN** 仍采用全流复制（`-c copy`），不引入任何重编码参数

### Requirement: Faststart flag for MP4 output

硬字幕烧录输出 MP4/MOV 容器时，系统 SHALL 追加 `-movflags +faststart`，将 moov box 前置，使输出文件可边下边播、拖动即时响应。

#### Scenario: MP4 输出包含 faststart

- **WHEN** 用户烧录输出为 `.mp4` 文件
- **THEN** ffmpeg 命令包含 `-movflags +faststart`，输出文件的 moov box 位于文件头部

#### Scenario: 非 MP4 容器不添加该参数

- **WHEN** 用户烧录输出为 `.mkv` 等非 MP4 系容器
- **THEN** 命令不包含 `-movflags +faststart`（该参数对 mkv 无意义）

### Requirement: Resolution-adaptive CRF adjustment

硬字幕烧录 SHALL 在用户所选画质档位（original=18 / high=20 / standard=23）基础上，按输出分辨率做 CRF 自适应微调：视频高度 ≥1800（4K 档）时 CRF +2。4K 像素密度下同等 CRF 感知质量冗余、体积翻倍不划算（借鉴 `docs/HEVC_encode(1).json` 的分辨率分档思想）。最终 CRF 与档位来源 SHALL 记录到日志。

#### Scenario: 1080p 视频保持档位基准 CRF

- **WHEN** 用户以"原画质"档位烧录一个 1920x1080 视频
- **THEN** 实际使用 CRF 18（基准值，无偏移）

#### Scenario: 4K 视频自动上调 CRF

- **WHEN** 用户以"原画质"档位烧录一个 3840x2160 视频
- **THEN** 实际使用 CRF 20（18 + 4K 偏移 2），并在日志中记录档位、偏移量与最终值

#### Scenario: 无法获取分辨率时回退基准值

- **WHEN** ffprobe 无法获取视频分辨率
- **THEN** 直接使用画质档位基准 CRF，不做偏移，烧录正常进行

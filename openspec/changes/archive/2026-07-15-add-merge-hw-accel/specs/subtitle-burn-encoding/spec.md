# subtitle-burn-encoding Spec Delta

## MODIFIED Requirements

### Requirement: Explicit video encoder and preset for hardcode output

硬字幕烧录 SHALL 按所选编码方式（`MergeConfig.encoderMode`，缺省 `'cpu'`）显式指定视频编码器与编码参数，不依赖 ffmpeg 按输出容器的隐式默认：

- `encoderMode='cpu'`（或未传）：`-c:v libx264 -preset medium`，行为与引入编码方式选择前完全一致。
- `encoderMode='hardware'`：使用主进程探测缓存解析出的硬件编码器（macOS: `h264_videotoolbox`；Windows: `h264_nvenc` 或 `h264_qsv`）及其对应质量参数；渲染层不直接指定编码器 ID。
- `encoderMode='hardware'` 但探测缓存无可用编码器时，SHALL 直接使用 libx264 路径并记录日志。

日志 SHALL 记录完整 ffmpeg 命令与实际选用的编码器，保证不同 ffmpeg 版本下编码行为可预期、可追溯。

#### Scenario: 烧录命令包含显式编码参数

- **WHEN** 用户以 CPU 编码方式执行硬字幕烧录
- **THEN** 生成的 ffmpeg 命令显式包含 `-c:v libx264` 与 `-preset medium`，且日志记录完整命令

#### Scenario: 硬件编码方式使用探测出的编码器

- **WHEN** 用户以硬件加速编码方式执行硬字幕烧录，且探测缓存为 `h264_nvenc`
- **THEN** 生成的 ffmpeg 命令显式包含 `-c:v h264_nvenc` 及其质量参数，日志记录实际编码器与完整命令

#### Scenario: 软字幕封装不受影响

- **WHEN** 用户选择软字幕封装（softmux）输出
- **THEN** 仍采用全流复制（`-c copy`），不引入任何重编码参数

## ADDED Requirements

### Requirement: Quality tier mapping for hardware encoders

硬件编码路径 SHALL 将画质档位（original/high/standard）映射为各编码器的恒定质量参数，映射表集中定义、便于校准（初值允许实现期在真实素材对比后微调）：

- `h264_nvenc`: `-rc vbr -cq {19/21/24} -b:v 0 -preset p5`，4K（高度≥1800）时 cq +2。
- `h264_qsv`: `-global_quality {19/21/24}`，4K 时 +2。
- `h264_videotoolbox`（恒定质量模式）: `-q:v {65/58/50}` + `-realtime 0`，4K 时 -5（量纲反向）。
- `h264_videotoolbox`（码率模式，Intel Mac）: 目标码率 = 估算源视频码率 × {1.0/0.85/0.65}，附 `-maxrate 1.5x -bufsize 2x`；源码率估算为 `文件大小×8/时长×0.85`（扣除音频占比），并按分辨率钳上下限；估算失败（如时长不可得）时该次合成 SHALL 回落 libx264 并记录日志。

libx264 路径的 CRF 档位与 4K 偏移规则保持既有要求不变。

#### Scenario: NVENC 按档位映射 CQ

- **WHEN** 用户以「高画质」档位、硬件加速（NVENC）烧录 1080p 视频
- **THEN** ffmpeg 命令包含 `-rc vbr -cq 21 -b:v 0`，日志记录档位与最终参数

#### Scenario: 4K 视频硬件档位等价偏移

- **WHEN** 用户以「原画质」档位、硬件加速（NVENC）烧录 3840×2160 视频
- **THEN** 实际使用 `-cq 21`（19 + 4K 偏移 2），日志记录偏移量与最终值

#### Scenario: Intel Mac 码率模式按源码率定档

- **WHEN** Intel Mac 用户以「原画质」档位硬件加速烧录一个 10 Mbps 总码率的视频
- **THEN** 目标视频码率约为 8.5 Mbps（10 × 0.85 × 1.0，含钳位），命令包含 `-b:v`、`-maxrate`、`-bufsize`

### Requirement: 8-bit pixel format for hardware encoding path

硬件编码路径 SHALL 在字幕滤镜之后追加 `format=nv12`，将 10-bit/4:2:2 等源统一转换为硬件编码器可接受的 8-bit 4:2:0 输入。libx264 路径 MUST NOT 追加该转换（保持现状对高位深源的行为）。

#### Scenario: 10-bit 源硬件烧录不报错

- **WHEN** 用户对 10-bit HEVC 源视频以硬件加速执行烧录
- **THEN** 滤镜链为 `<字幕滤镜>,format=nv12`，编码正常完成

#### Scenario: CPU 路径滤镜链不变

- **WHEN** 用户以 CPU 编码方式执行烧录
- **THEN** 滤镜链仅含字幕滤镜，无 `format=nv12`

### Requirement: Automatic fallback to CPU encoding on hardware failure

硬件编码合成中途失败且非用户取消时，系统 SHALL 自动回退：清理半成品输出文件 → 记录 warning 日志 → 通知渲染层「已自动切换 CPU 编码重试」→ 以 libx264 参数从 0% 重新合成，仅重试一次。用户取消（`MERGE_CANCELLED`）MUST NOT 触发回退。回退后的重试若再失败，按既有错误流程上报。

#### Scenario: 硬件编码失败自动回退成功

- **WHEN** NVENC 合成启动后因驱动特性报错失败
- **THEN** 系统清理半成品、记录日志并通知界面，自动以 libx264 重跑并正常完成，输出文件有效

#### Scenario: 用户取消不触发回退

- **WHEN** 用户在硬件加速合成过程中点击取消
- **THEN** 按既有取消流程清理并静默复位，不启动 CPU 重试

#### Scenario: 回退重试仍失败按错误上报

- **WHEN** 硬件编码失败回退 libx264 后再次失败
- **THEN** 界面显示错误状态与错误信息，不再进行第二次重试

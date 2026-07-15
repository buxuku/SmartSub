# Spec: merge-encoder-selection

## Purpose

合成编码方式选择：硬件编码器运行时黑帧试编码探测与会话级缓存、编码方式选择控件（默认 CPU、平台可见性、不可用禁用态）、体积增大提示、合成偏好持久化。

## Requirements

### Requirement: Runtime hardware encoder detection

系统 SHALL 通过「带目标画质参数的黑帧试编码」在运行时真实探测硬件编码器可用性，而非仅检查 ffmpeg 编码器列表或嗅探平台/CPU 架构。探测规则：

- 测试输入为 `lavfi color=black:s=640x360:d=0.1`（640×360 规避 NVENC 最小分辨率限制），输出 `-f null`，试编码成功即视为可用。
- 候选编码器按平台确定：macOS 为 `h264_videotoolbox`；Windows 按 `h264_nvenc` > `h264_qsv` 优先级取第一个可用者；Linux 无候选。
- VideoToolbox 先以恒定质量参数（`-q:v`）探测，失败则以码率参数二次探测，通过则标记为码率模式（覆盖 Intel Mac）。
- QSV 以 `-global_quality` 探测，失败即视为不可用（不降级码率模式）。
- 探测结果在主进程内存缓存整个会话，不持久化（避免用户更换显卡/驱动后结果过期）；渲染层经 IPC `subtitleMerge:getHwAccelInfo` 异步获取 `{ available, encoderId, encoderLabel, rateMode, platformSupported }`。

#### Scenario: Apple Silicon Mac 探测为恒定质量模式

- **WHEN** 应用运行于 Apple Silicon Mac，渲染层请求硬件加速信息
- **THEN** 返回 `available=true`、`encoderId=h264_videotoolbox`、`rateMode=cq`

#### Scenario: Intel Mac 降级为码率模式

- **WHEN** 应用运行于 Intel Mac（`-q:v` 试编码失败、码率参数试编码成功）
- **THEN** 返回 `available=true`、`encoderId=h264_videotoolbox`、`rateMode=bitrate`

#### Scenario: Windows 无独显/驱动异常时不可用

- **WHEN** Windows 机器上 NVENC 与 QSV 试编码均失败
- **THEN** 返回 `available=false`、`platformSupported=true`，UI 据此禁用硬件选项并说明原因

#### Scenario: 同会话重复请求命中缓存

- **WHEN** 渲染层在同一应用会话内第二次请求硬件加速信息
- **THEN** 直接返回缓存结果，不重复执行试编码

### Requirement: Encoder mode selection control

合成输出行动条 SHALL 提供「编码方式」选择控件：`CPU`（默认）与 `硬件加速` 两项。可见性与状态规则：

- 仅硬字幕烧录（hardcode）模式显示；软字幕封装（softmux）不编码，隐藏该控件。
- Linux 平台（`platformSupported=false`）隐藏整个控件。
- 探测结果不可用或未返回时，硬件项呈禁用态并以 tooltip 说明原因；CPU 路径不受探测阻塞。
- 探测到的编码器名称（如 NVIDIA NVENC、Intel QSV、VideoToolbox）SHALL 在界面（tooltip 或说明文案）中可见。
- 控件措辞避免「GPU 加速」字样（与设置页 whisper 转录后端的既有命名区分）。

#### Scenario: 默认选中 CPU

- **WHEN** 用户首次打开合成面板（无持久化偏好）
- **THEN** 编码方式默认为 CPU，行为与引入本功能前完全一致

#### Scenario: softmux 模式隐藏控件

- **WHEN** 用户切换输出方式为软字幕封装
- **THEN** 编码方式控件隐藏（同现有画质选择的隐藏行为）

#### Scenario: 无可用硬件时禁用并说明

- **WHEN** 探测返回 `available=false`
- **THEN** 硬件加速项禁用，tooltip 说明未检测到可用硬件编码器；用户仍可正常使用 CPU 合成

### Requirement: File size increase hint

用户选择「硬件加速」时，系统 SHALL 以两层方式提示体积代价：编码方式控件的 tooltip 常驻说明速度/体积权衡；选中硬件加速后行动条内出现内联提示，说明相同画质下输出体积可能明显大于 CPU 编码（约 30%~100%）。文案 SHALL 提供 zh/en 两份。

#### Scenario: 选中硬件加速出现内联提示

- **WHEN** 用户将编码方式切换为硬件加速
- **THEN** 行动条显示体积增大内联提示；切回 CPU 后提示消失

#### Scenario: 中英文案完整

- **WHEN** 用户切换应用语言为 en
- **THEN** 编码方式控件、tooltip、内联提示均显示英文文案

### Requirement: Merge preferences persistence

系统 SHALL 将合成偏好 `{ outputMode, videoQuality, encoderMode }` 持久化到应用存储，面板挂载时读取恢复，用户变更即写入。持久化的 `encoderMode='hardware'` 在当前会话探测不可用时，UI SHALL 回落为 CPU 显示且硬件项禁用，但 MUST NOT 改写存储值（换回有硬件的环境自动恢复硬件选择）。

#### Scenario: 偏好跨会话恢复

- **WHEN** 用户选择硬件加速 + 高画质 + 烧录模式后关闭应用并重新打开合成面板
- **THEN** 三项偏好恢复为上次选择

#### Scenario: 硬件不可用时回落显示不改写存储

- **WHEN** 持久化 `encoderMode='hardware'` 但本会话探测不可用
- **THEN** UI 按 CPU 模式显示并禁用硬件项，实际合成走 libx264；存储值保持 `'hardware'` 不变

## ADDED Requirements

### Requirement: 输出容器可写性

合成引擎 SHALL 保证成品容器写得下它要写入的流：硬烧写 H.264，配音替换/混音/双轨写 AAC，而 WebM/Ogg 容器（`.webm`、`.ogv`、`.ogg`）只接受 VP8/VP9/AV1 视频与 Vorbis/Opus 音频。因此：

- 所有默认输出路径（合成工作台、主进程回退路径——含 CLI/MCP `compose.run` 未传 `outputPath` 时、流水线成品、配音导出）MUST NOT 以 WebM/Ogg 结尾：源视频为这些扩展名时默认输出 `.mp4`；软封字幕或双音轨参与时仍为 `.mkv`；其余源扩展名保持既有行为。
- 显式给出 WebM/Ogg 输出路径的合成作业 MUST 被拒绝，且在三处都不产生副作用：入队时（不进入队列与历史）、作业执行时（不创建暂存目录、不启动 ffmpeg）、命令构建时。错误信息 SHALL 点明该容器写不下 H.264/AAC，并建议改用 `.mp4` 或 `.mkv`。

#### Scenario: WebM 源硬烧默认输出 MP4

- **WHEN** 用户在合成页选择 `clip.webm`（VP9 + Opus），选硬烧字幕且未手动改输出路径
- **THEN** 默认输出路径为 `clip_subtitled.mp4`，作业成功，成品视频为 H.264、音频为 AAC

#### Scenario: WebM 源软封字幕仍输出 mkv

- **WHEN** 用户选择 `clip.webm` 并选软封字幕
- **THEN** 默认输出路径为 `.mkv`，行为与引入本要求前一致

#### Scenario: 其它源扩展名的默认命名不变

- **WHEN** 源视频为 `.mp4`、`.mkv`、`.mov` 或 `.avi` 并选硬烧字幕
- **THEN** 默认输出扩展名与引入本要求前完全一致

#### Scenario: 配音导出的 WebM 源改写 MP4

- **WHEN** 对 `.webm` 源视频执行配音导出（替换音轨，视频直拷）
- **THEN** 默认输出为 `.mp4`，视频流直拷、音轨为 AAC，作业成功

#### Scenario: 显式 WebM 输出被拒绝且无副作用

- **WHEN** 经界面、CLI 或 MCP 提交 `outputPath` 以 `.webm` 结尾的合成作业
- **THEN** 作业立即失败并返回含 `.mp4`/`.mkv` 建议的可读错误，队列与历史中没有该作业，未创建暂存目录，未启动 ffmpeg

### Requirement: WebM/Ogg 源硬烧保留原声的音频处理

硬烧字幕且保留原声（`subtitle=hard`、`audio=keep`）时，合成引擎 SHALL 对音频流流复制（`-c:a copy`）；唯独当源视频为 WebM/Ogg（`.webm`、`.ogv`、`.ogg`）且输出为 MP4 系容器（`.mp4`、`.m4v`、`.mov`）时，MUST 把原声重编码为 AAC（192k）。Opus/Vorbis 虽可直拷进 MP4，但常见播放器、剪辑软件与投稿站对其支持不稳，`.mov`/`.m4v` 还会拒绝一部分。其它任何组合（包括输出为 `.mkv`）MUST 保持流复制。

#### Scenario: WebM 源烧录到 MP4 原声转 AAC

- **WHEN** 以 `subtitle=hard`、`audio=keep` 把 `clip.webm`（Opus 原声）合成为 `.mp4`
- **THEN** 命令中音频为 AAC 192k，成品音频流为 AAC

#### Scenario: 手动选择 mkv 保持直拷

- **WHEN** 用户把输出改为 `.mkv`
- **THEN** 命令保持 `-c:a copy`，Opus 原声无损保留

#### Scenario: 其它源与容器组合不变

- **WHEN** 以 `subtitle=hard`、`audio=keep` 合成 `.mov` 源到 `.mp4`，或 `.avi` 源到 `.avi`
- **THEN** 命令保持 `-c:a copy`，与引入本要求前逐参数一致

### Requirement: 合成失败原因可见

合成作业因 ffmpeg 非零退出而失败时，错误消息 SHALL 形如 `ffmpeg exited with code N: <原因>`，其中原因取自 ffmpeg 输出里真正的失败行（去掉对象地址 `@ 0x…`、版本横幅、进度与 `Conversion failed!` 等包装行，至多 8 行），MUST NOT 只剩 `Conversion failed!` 或空白。该消息 SHALL 同时作为作业事件的 `errorMessage`（合成页错误详情）、硬件回退日志与作业失败日志的内容。引擎还 SHALL 以 error 级别把 ffmpeg 输出的末尾约 40 行写入日志；合成页错误详情 SHALL 保留换行显示。取不到可用原因时 MUST 保持原错误不变；用户取消、被信号终止与启动失败 MUST NOT 受影响。

#### Scenario: 奇数宽度源硬烧失败说明原因

- **WHEN** 对 853x480 的 yuv420p 源用 libx264 硬烧而失败
- **THEN** 错误消息包含 `width not divisible by 2 (853x480)`，合成页错误详情逐行显示，日志含 ffmpeg 输出的末尾

#### Scenario: 硬件回退日志说明真实原因

- **WHEN** 硬件编码器不可用而自动回退 CPU 重试
- **THEN** 回退日志包含 `Unknown encoder …` 等真实原因，而不是空的 `ffmpeg exited with code 1: `

#### Scenario: 取消不产生失败文案

- **WHEN** 用户取消运行中的合成作业
- **THEN** 作业按取消语义收尾，不写失败原因日志，错误消息仍是取消标记

# Spec: subtitle-burn-ass-pipeline

## Purpose

硬字幕烧录的 ASS 生成管线：SRT/VTT/LRC 输入预生成完整 ASS 文档（显式 384×288 脚本空间、等比缩放），Style 行完整映射用户样式与背景取色语义，背景不透明度可配，保留 CJK 字体兜底；ASS/SSA 输入维持既有 force_style 路径。

## Requirements

### Requirement: Burn via pre-generated ASS document

系统对 SRT/VTT/LRC 字幕输入执行硬字幕烧录时，SHALL 先将字幕解析为 cue 列表并生成完整 ASS 文档（含 `[Script Info]`、`[V4+ Styles]`、`[Events]` 三节），写入临时文件后通过 ffmpeg `ass` 滤镜烧录，不再使用 `subtitles` 滤镜的 `force_style` 参数传递样式。临时 ASS 文件 SHALL 在烧录结束（成功、失败或取消）后清理。

#### Scenario: SRT 输入走 ASS 管线

- **WHEN** 用户选择一个 `.srt` 字幕文件执行硬字幕烧录
- **THEN** 系统生成临时 ASS 文件并以 `ass='<临时文件路径>'` 滤镜烧录，日志记录生成的 Style 行与滤镜字符串

#### Scenario: 烧录结束清理临时文件

- **WHEN** 烧录完成、失败或被用户取消
- **THEN** 生成的临时 ASS 文件被删除

#### Scenario: ASS/SSA 输入维持原路径

- **WHEN** 用户选择 `.ass`/`.ssa` 字幕文件执行硬字幕烧录
- **THEN** 系统沿用现有 `subtitles` 滤镜 + `force_style` 路径，行为与重构前一致

### Requirement: Explicit script resolution and scaling

生成的 ASS 文档 SHALL 显式声明 `PlayResX: 384`、`PlayResY: 288`（与 ffmpeg 对 SRT 隐式转换所用脚本空间一致，保证既有用户样式数值的烧录观感不变）及 `ScaledBorderAndShadow: yes`，使字号、边距、描边、阴影在任意视频分辨率下按脚本空间等比缩放，行为确定、可预期。

#### Scenario: 同一样式在不同分辨率下等比呈现

- **WHEN** 用户以相同样式设置分别烧录 720p 和 4K 视频
- **THEN** 两个输出中字幕占画面的相对大小、边距比例、描边粗细比例一致

#### Scenario: 与重构前字号观感一致

- **WHEN** 用户使用重构前保存的样式配置（如 fontSize=24）烧录同一视频
- **THEN** 输出字幕大小与重构前版本烧录结果一致（脚本空间同为 384x288）

### Requirement: Style line maps user style with correct background semantics

生成的 ASS `Style` 行 SHALL 完整映射用户 `SubtitleStyle`（字体、字号、颜色、粗斜体下划线、BorderStyle、Outline、Shadow、Alignment、边距），其中背景相关字段按 libass 实际取色语义映射：BorderStyle=3（背景框）时 `OutlineColour` 与 `BackColour` 均取用户背景色并携带用户设置的不透明度 alpha；BorderStyle=1（边框+阴影）时 `OutlineColour` 取描边色（不透明）、`BackColour` 取背景/阴影色并携带用户 alpha。

#### Scenario: 背景框颜色所设即所得

- **WHEN** 用户选择背景框模式、背景色红色 `#FF0000`、不透明度 30% 并烧录
- **THEN** 输出视频字幕背后为 30% 不透明度的红色背景框（Style 行 `OutlineColour=&HB30000FF`）

#### Scenario: 边框+阴影模式行为不变

- **WHEN** 用户选择边框+阴影模式烧录
- **THEN** 描边使用描边色、阴影使用背景/阴影色，与重构前观感一致

### Requirement: Background opacity is user-configurable

系统 SHALL 提供背景不透明度设置（0–100%，默认 50%），并转换为 ASS 颜色 alpha 通道（`&HAA..`，00=不透明、FF=全透明）。历史配置与预设缺少该字段时 SHALL 按 50% 处理。

#### Scenario: 设置完全不透明背景

- **WHEN** 用户将背景不透明度设为 100% 并以背景框模式烧录
- **THEN** 背景框完全不透明（alpha=`&H00`）

#### Scenario: 旧配置无不透明度字段

- **WHEN** 加载不含 `backOpacity` 的历史样式配置或内置预设
- **THEN** 按 50% 处理，不报错、不影响其它字段

### Requirement: CJK font fallback preserved in ASS pipeline

ASS 管线 SHALL 保留现有 CJK 字体兜底逻辑：字幕含 CJK 字符且所选字体在本机不可用/无 CJK 字形时，Style 行的 `Fontname` 替换为平台可用的 CJK 字体，并记录日志。

#### Scenario: 中文字幕选用纯拉丁字体

- **WHEN** 字幕包含中文且用户选择了 Arial 字体烧录
- **THEN** 生成的 Style 行使用平台 CJK 兜底字体（如 macOS 的 Hiragino Sans GB），日志说明替换原因

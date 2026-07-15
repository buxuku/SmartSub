# Refactor Subtitle Burn: ASS Pre-generation Pipeline

## Why

当前硬字幕烧录用 `subtitles` 滤镜 + `force_style` 给 SRT 临时打样式补丁，存在系统性缺陷：

1. **背景颜色不生效**：`backColor` 写入 ASS `BackColour`，但 BorderStyle=3（背景框）模式下 libass 的背景框取色自 `OutlineColour`，用户改背景色画面无变化；背景 alpha 硬编码 128，无透明度设置。
2. **字号语义隐式、预览失真**：SRT 经 ffmpeg 隐式转 ASS 时 PlayRes 取 libass 默认值（384x288），字号缩放语义不可控，前端只能靠实测标定的魔法常数 `LIBASS_SRT_PLAYRES_Y=333` 近似模拟，历史上为"预览字号 ≠ 烧录字号"反复调试多轮，且 CSS 模拟与 libass 渲染的字形度量差异永远无法收敛到一致。
3. **不同分辨率行为不确定**：样式效果依赖隐式缩放，720p/1080p/4K 之间预览与成品的一致性无法保证。

行业通用做法（Aegisub、HandBrake、专业发布管线、参考脚本 `docs/burn_subtitles(1).py` 的 `write_ass_document`）是**预生成带显式 PlayRes 与完整 Style 定义的 ASS 文件**，再用 `ass` 滤镜烧录。项目已有零依赖的字幕解析/序列化模块（`main/helpers/subtitleFormats.ts`，含 ASS 序列化），重构基础具备。

## What Changes

- **烧录管线重构为 ASS 预生成**：SRT/VTT/LRC 输入解析为 cue 列表，按用户 `SubtitleStyle` 生成带显式 `PlayResX/PlayResY`、`ScaledBorderAndShadow: yes` 和完整 `[V4+ Styles]` 的 ASS 临时文件，用 `ass` 滤镜烧录，替代 `subtitles + force_style`。
- **修复背景框颜色与透明度**：Style 行中按 BorderStyle 正确映射取色字段；新增背景不透明度设置（0–100%），写入 ASS 颜色 alpha 通道。
- **预览改用 libass 渲染引擎（WYSIWYG）**：渲染层引入 libass 的 WASM 移植（JASSUB），预览与烧录消费**同一份生成的 ASS 内容**，同一渲染引擎保证字号、换行、背景框、描边、阴影像素级一致，废除 CSS 模拟的标定常数体系（保留 CSS 模拟作为 WASM 不可用时的降级方案）。
- **借鉴参考脚本的编码改进**：显式 `-c:v libx264 -preset medium`；MP4 系容器追加 `-movflags +faststart`；CRF 按分辨率自适应微调（4K +2）。
- **不纳入**（Non-goals）：HEVC/libx265、源编码器 CRF 偏移、帧率降级、封面嵌入、overlay 信息条（分发场景特性，另立 change）；ASS/SSA 输入文件维持现有 `subtitles + force_style` 路径不动（尊重其自带样式的复杂性，避免破坏性转换）。

## Capabilities

### New Capabilities

- `subtitle-burn-ass-pipeline`: ASS 预生成烧录管线——cue 解析、Style 构建（含背景色/透明度正确映射）、显式 PlayRes、`ass` 滤镜烧录、临时文件生命周期。
- `subtitle-burn-preview`: 所见即所得预览——JASSUB（libass WASM）渲染与烧录相同的 ASS 内容、系统字体供给、CSS 降级方案。
- `subtitle-burn-encoding`: 烧录输出编码——显式编码器/preset、faststart、分辨率自适应 CRF。

### Modified Capabilities

（无——`openspec/specs/` 下没有覆盖字幕合成的既有 spec）

## Impact

- **主进程**：`main/helpers/subtitleMerger.ts`（烧录管线改造）；新增 `main/helpers/assStyleBuilder.ts`（或并入 `subtitleFormats.ts`：SubtitleStyle → ASS 文档生成）；`main/helpers/ipcSubtitleMergeHandlers.ts`（新增"生成预览用 ASS 内容"与"读取字体文件"IPC）。
- **类型**：`types/subtitleMerge.ts`（`SubtitleStyle` 增加 `backOpacity`）。
- **渲染层**：`SubtitlePreviewOverlay.tsx` / `VideoPreview.tsx`（JASSUB 渲染集成）、`AdvancedStyleSettings.tsx`（透明度控件）、`utils/styleUtils.ts`（降级为 fallback 路径）、`constants.ts`（默认值与预设）。
- **依赖**：新增 `jassub`（渲染层，含 WASM 资源，需随 Nextron 静态资源打包）。
- **国际化**：`renderer/public/locales/{zh,en}/subtitleMerge.json`。
- **兼容性**：ASS 脚本空间沿用 ffmpeg 隐式转换的 384x288，既有用户保存的字号/边距等数值语义与烧录观感完全不变；旧配置无 `backOpacity` 时默认 50% 回退。

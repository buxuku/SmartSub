# Design: Refactor Subtitle Burn — ASS Pre-generation Pipeline

## Context

**现状链路**：UI → `useSubtitleMerge.startMerge()` → IPC `subtitleMerge:startMerge` → `mergeSubtitleToVideo()`（`main/helpers/subtitleMerger.ts`），SRT 直接喂给 `subtitles` 滤镜，样式经 `buildForceStyle()` 拼成 `force_style` 字符串。

**三个系统性问题**：

1. _背景色 bug_：`backColor` → `BackColour`，但 ASS/libass 规范中 BorderStyle=3 的背景框取色自 `OutlineColour`；`BackColour` 仅用于阴影区。alpha 硬编码 128，UI 无透明度入口。
2. _字号语义隐式_：ffmpeg 对 SRT 隐式转 ASS 时 PlayResX/Y=384/288（libass 默认），前端 CSS 预览只能靠实测标定常数 `LIBASS_SRT_PLAYRES_Y=333` 近似（`styleUtils.ts` 注释记录了标定过程），字号一致性历史上调试多轮，且浏览器与 libass 字形度量差异使 CSS 模拟永远无法精确收敛。
3. _预览三重失真_：背景 alpha 预览 0.7 vs 烧录 0.5、预览有圆角（libass 无）、换行/描边为 CSS 近似。

**可复用资产**：`main/helpers/subtitleFormats.ts` 已有 SRT/VTT/ASS/LRC 解析与 ASS 序列化（含固定头模板）；`subtitleMerger.ts` 已有 CJK 字体兜底（`resolveBurnFontName` + `MAC_CJK_FONTS` 字体文件路径表）、临时文件机制（`createSafeSubtitleCopy`）。

**行业参照**：Aegisub（编辑器内直接用 libass 渲染）、HandBrake、参考脚本 `docs/burn_subtitles(1).py`（`write_ass_document` 预生成 ASS + `ass` 滤镜）均为"预生成 ASS"路线；Web 端 WYSIWYG 字幕渲染的通行方案是 libass 的 WASM 移植（SubtitlesOctopus / 其维护分支 JASSUB）。

## Goals / Non-Goals

**Goals:**

- 烧录样式由生成的 ASS 文档完整承载：单一样式来源，语义显式、可日志、可复现。
- 背景框颜色/透明度所设即所得；不同分辨率视频样式等比一致。
- 预览与烧录同引擎（libass）、同输入（同一份 ASS 内容），彻底终结标定常数体系。
- 既有用户样式数值（字号/边距等）烧录观感零回归。
- 编码参数显式化 + faststart + 分辨率 CRF 微调。

**Non-Goals:**

- ASS/SSA 输入文件的重新样式化（维持现有 force_style 路径，尊重其自带样式，避免破坏卡拉OK/特效字幕）。
- HEVC/libx265、源编码器 CRF 偏移、帧率降级、封面、overlay（分发场景，另立 change）。
- 双语双样式、逐条样式覆盖等高级排版能力（本次只做全局 Default Style）。

## Decisions

### D1: SRT/VTT/LRC → 预生成 ASS + `ass` 滤镜；ASS/SSA 输入维持原路径

新增 `main/helpers/assStyleBuilder.ts`：

- `buildAssStyleLine(style, opts)`：`SubtitleStyle` → `[V4+ Styles]` 的 Style 行（见 D3 颜色映射）。
- `buildAssDocument(cues, style, opts)`：复用 `parseSubtitleCues()` 的解析结果，产出完整 ASS 文本（Script Info + Styles + Events，硬换行转 `\N`）。
- 烧录侧：ASS 文本写入 `os.tmpdir()/video-subtitle-master/`（复用现有临时目录约定，天然规避路径特殊字符问题），滤镜从 `subtitles='...':force_style='...'` 换为 `ass='<tmp>.ass'`，`end`/`error` 回调统一清理。

**ASS/SSA 输入不走新管线**：现有 `parseAss()` 会剥离覆盖标签（`{\...}`）与逐条样式，重新序列化属破坏性转换。维持 `subtitles + force_style` 现状，重构后行为不变。

**备选项**：继续 force_style 并只做字段重映射（上一版方案）——能修背景色 bug，但字号隐式语义与预览失真是结构性问题，修补方案无法触及；用户已明确选择重构路线。

### D2: 脚本空间沿用 384x288（兼容优先）

`PlayResX: 384, PlayResY: 288, ScaledBorderAndShadow: yes, WrapStyle: 0`。

这正是 ffmpeg 对 SRT 隐式转换所用的脚本空间——沿用它意味着**所有既有用户保存的字号、边距、描边、阴影数值的烧录结果与重构前逐像素等价**，零回归、零迁移。字号在任意分辨率下按 `视频高度/288` 等比缩放，语义从"碰巧如此"变为"显式声明"。

**备选项**：改用 1920x1080 等"现代"设计空间——语义更直观，但既有配置里 fontSize=24 的含义突变（视觉缩小约 3.75 倍），需要迁移所有持久化配置与预设，收益不抵风险。`subtitleFormats.ts` 现有导出用 ASS_HEADER（PlayRes 1920x1080）是给"导出字幕文件"场景用的，与烧录管线的头分开维护，互不影响。

### D3: Style 行颜色映射与背景不透明度

- `SubtitleStyle` 新增 `backOpacity?: number`（0–100，缺省 50，与现状 alpha=128≈50% 观感连续）；`assAlpha = round((1 - backOpacity/100) * 255)`。
- BorderStyle=3：`OutlineColour = backColor+alpha`（libass 实际的背景框取色字段），`BackColour = backColor+alpha`（阴影区同色，避免 shadow>0 露异色边）；`Outline` 值即背景框 padding。
- BorderStyle=1：`OutlineColour = outlineColor`（不透明描边），`BackColour = backColor+alpha`（阴影，顺带获得透明度）。
- 保留 `resolveBurnFontName()` CJK 兜底，作用于 Style 行 `Fontname`。

**备选项**：BorderStyle=4（libass 扩展，box 直接取 `BackColour`，逐行紧贴 box）——语义更"正"但属非标扩展，观感与 BorderStyle=3 整块 box 不同；且 JASSUB 与打包 ffmpeg 的 libass 版本可能有行为差异。选标准 BorderStyle=3 + 字段映射，预览烧录两端均无歧义。

### D4: 预览 = JASSUB 渲染同一份 ASS

- 渲染层引入 [`jassub`](https://github.com/ThaUnknown/jassub)（SubtitlesOctopus 的维护分支，libass WASM 移植），以 canvas 叠加在 `VideoPreview` 视频层之上。
- **单一来源**：新增 IPC `subtitleMerge:buildPreviewAss`——渲染层把当前 `style` + 字幕路径（或样例文本）发给主进程，主进程用与烧录**完全相同的** `buildAssDocument()` 返回 ASS 文本，JASSUB 以字符串形式加载。样式变更时 debounce 重新生成并 `setTrack`。
- **字体供给**（WASM 无法访问系统字体）：新增 IPC `subtitleMerge:getFontData`——主进程按字体名解析本机字体文件（复用/扩展 `MAC_CJK_FONTS` 路径表；Windows 查 `C:\Windows\Fonts` 常见映射；Linux 走 fontconfig 常见路径），读文件返回 ArrayBuffer，渲染层喂给 JASSUB 的 `fonts`/`availableFonts`。解析失败时仅加载平台默认 CJK 字体（与烧录端 `resolveBurnFontName` 兜底行为对应）。
- **降级**：JASSUB 初始化失败（WASM 资源缺失、环境限制）时回退现有 CSS 模拟（`subtitleStyleToCSS`，同步修正其背景 alpha/圆角），记录日志。`styleUtils.ts` 与 333 常数保留但仅服务降级路径。
- **打包**：jassub 的 worker/wasm/默认字体资源需置于 `renderer/public/` 由 Nextron 静态服务，确认生产构建（`serve` 静态导出）可加载。

**备选项**：继续打磨 CSS 模拟——浏览器与 libass 的字形度量、换行算法、描边渲染差异是结构性的，只能无限逼近；WYSIWYG 是本次重构的核心诉求，值得引入一个纯前端依赖。

### D5: 编码参数（与上版方案一致）

```text
-c:v libx264  -preset medium  -crf <tier + (height>=1800 ? 2 : 0)>  -c:a copy  [-movflags +faststart(.mp4/.mov/.m4v)]  -y
```

分辨率来自既有 `getVideoInfo()`；获取失败偏移为 0。不设 `-pix_fmt`/`-profile`/`-maxrate`：本地保存场景跟随源位深更保真，显式 8-bit profile 反而会在 10-bit 源上出问题（与参考脚本的分发场景有意不同）。

### D6: 参考脚本借鉴项取舍总结

| 参考脚本特性                                   | 决定             | 理由                                                                                               |
| ---------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| 预生成 ASS（`write_ass_document`）+ `ass` 滤镜 | **纳入（核心）** | 行业标准路线，根治样式语义与背景色问题                                                             |
| 显式 PlayRes / 分辨率感知样式档位              | 纳入（形式调整） | 用固定 384x288 脚本空间 + 等比缩放实现分辨率一致性，不做 per-分辨率字号档位（UI 已有直接字号控制） |
| 临时目录规避路径问题                           | 已具备           | 现有 `createSafeSubtitleCopy` 机制，ASS 临时文件同目录                                             |
| `-movflags +faststart`                         | 纳入             | 零成本改善播放体验                                                                                 |
| 显式 encoder/preset                            | 纳入             | 消除 ffmpeg 版本差异                                                                               |
| 分辨率分档 CRF                                 | 简化纳入         | 仅 4K +2 一条规则                                                                                  |
| HEVC/libx265 + hvc1                            | 不纳入           | 编码耗时数倍，桌面即时工具不适用                                                                   |
| 源编码器 CRF 偏移 / 帧率降级 / 封面 / overlay  | 不纳入           | 分发场景特性，另立 change                                                                          |

## Risks / Trade-offs

- [JASSUB 依赖引入：WASM 资源打包、Nextron 静态导出兼容性] → 资源放 `renderer/public/`；实现早期先验证生产构建加载，失败即触发 CSS 降级路径，功能不受阻。
- [Windows/Linux 字体文件解析覆盖不全] → 预览端字体兜底到平台默认 CJK 字体（烧录端本就有同语义兜底）；字形不同于所选字体时预览仍是"libass 渲染的近似"，比 CSS 模拟仍准确得多。
- [JASSUB 内嵌 libass 版本与 ffmpeg-static 内 libass 版本行为差异] → 只使用 ASS 标准特性（BorderStyle 1/3、基础 Style 字段），避开扩展特性（BorderStyle=4、`\blur` 等），两端行为一致性风险可忽略。
- [每次样式变更重新生成 ASS + setTrack 的性能] → ASS 文本生成为纯字符串操作（毫秒级），debounce 200ms 内更新，体验优于现状。
- [BorderStyle=3 下描边色字段被背景色占用] → 该模式 libass 本就不绘制描边，无感知损失。
- [4K CRF +2 画质争议] → 偏移仅 +2、日志透明；4K"原画质"档 CRF 20 仍属视觉无损区间。
- [faststart 收尾二次写入] → 长视频多几秒收尾，进度 99%→100% 略停顿，可接受。

## Migration Plan

1. 先落地主进程 ASS 管线（烧录正确性，独立可验证、可发布）。
2. 再落地 JASSUB 预览（依赖 1 的 `buildAssDocument`）。
3. 编码参数改动独立、随任一阶段发布。
   回滚：恢复旧版代码即可；`backOpacity` 为可选字段，无持久化格式破坏。

## Open Questions

- jassub 的 npm 包版本与 Next.js（Nextron 静态导出）集成细节：worker 路径配置方式以实现时实际验证为准。
- 预设样式是否为个别预设（如 YouTube 风格）设置更高默认不透明度（80%）：实现时定夺。

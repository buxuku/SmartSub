# Tasks: Refactor Subtitle Burn — ASS Pre-generation Pipeline

## 1. 类型与默认值

- [x] 1.1 `types/subtitleMerge.ts`：`SubtitleStyle` 新增可选字段 `backOpacity?: number`（0–100，注释说明默认 50 与 ASS alpha 换算）
- [x] 1.2 `renderer/components/subtitleMerge/constants.ts`：`DEFAULT_STYLE` 与 5 个预设补充 `backOpacity`（默认 50，YouTube 风格可用 80），新增 `BACK_OPACITY_RANGE`

## 2. 主进程：ASS 生成模块

- [x] 2.1 新增 `main/helpers/assStyleBuilder.ts`：`buildAssStyleLine(style)` 实现 SubtitleStyle → Style 行映射（含 D3 的 BorderStyle 分支取色、backOpacity → alpha 换算、Alignment numpad→ASS 转换复用）
- [x] 2.2 `buildAssDocument(cues, style)`：生成完整 ASS 文本（Script Info: PlayResX=384/PlayResY=288/ScaledBorderAndShadow=yes/WrapStyle=0；Events 硬换行转 `\N`），复用 `subtitleFormats.ts` 的 `formatAssTime`
- [x] 2.3 CJK 字体兜底接入：`resolveBurnFontName()` 的结果作用于 Style 行 `Fontname`（抽至 `main/helpers/fontResolver.ts` 供烧录与预览共用）

## 3. 主进程：烧录管线切换

- [x] 3.1 `mergeSubtitleToVideo()`：SRT/VTT/LRC 输入改走"解析 cues → `buildAssDocument` → 写临时 `.ass` → `ass='<tmp>'` 滤镜"；ASS/SSA 输入保留原 `subtitles + force_style` 路径
- [x] 3.2 临时 ASS 文件生命周期：写入 `os.tmpdir()/video-subtitle-master/`，`end`/`error`（含取消）回调统一清理
- [x] 3.3 日志：记录生成的 Style 行与最终滤镜字符串，便于排查
- [x] 3.4 编码参数：显式 `-c:v libx264 -preset medium`；`.mp4`/`.mov`/`.m4v` 输出追加 `-movflags +faststart`；4K（height≥1800）CRF +2，日志记录档位/偏移/最终值；确认 softmux 分支不受影响

## 4. 主进程：预览支撑 IPC

- [x] 4.1 新增 IPC `subtitleMerge:buildPreviewAss`：入参字幕路径 + 当前 style，复用 `buildAssDocument` 返回 ASS 文本字符串
- [x] 4.2 新增 IPC `subtitleMerge:getFontData`：按字体名解析本机字体文件路径（扩展 `MAC_CJK_FONTS`；Windows/Linux 常见路径映射），返回字体二进制；解析失败返回平台默认 CJK 字体数据

## 5. 渲染层：JASSUB 预览引擎

- [x] 5.1 引入 `jassub` 依赖（2.5.6 为 ESM + module worker，webpack5 的 `new Worker(new URL())` 模式自动打包 worker/wasm，无需手动复制资源到 public/；`yarn dev` 验证见 6.4）
- [x] 5.2 `VideoPreview.tsx` 集成 JASSUB（新增 `hooks/useJassubPreview.ts`）：canvas 由 JASSUB 挂到 video 元素旁，经 `buildPreviewAss` 获取 ASS 内容渲染；样式/字幕变更 debounce 200ms setTrack
- [x] 5.3 字体加载：经 `getFontData` 取字体二进制喂给 JASSUB（构造时 `fonts` + 切换字体时 `renderer.addFonts` 增量加载）
- [x] 5.4 降级路径：JASSUB 初始化失败时回退 CSS 模拟并记录日志；同步修正 `styleUtils.ts`——背景色/阴影色用 `backColor + backOpacity`（替换硬编码 0.7）、删除 `borderRadius`
- [x] 5.5 `AdvancedStyleSettings.tsx`：新增背景不透明度 Slider（0–100%，步进 5）；`renderer/public/locales/{zh,en}/subtitleMerge.json` 补充文案

## 6. 验证

- [x] 6.1 类型检查/构建通过（`tsc -p renderer` 无新增错误；`yarn build` 通过，jassub worker/wasm 正确进入静态导出产物；`yarn check:i18n` 通过；新增 `yarn test:ass-builder` 单元断言全绿）
- [x] 6.2 烧录正确性：SRT 中文字幕背景框模式（红色 + 30%/100% 不透明度）烧录后输出正确的红色背景框（截帧验证）；边框+阴影模式与重构前 force_style 输出 PSNR ≈ 39.8dB（仅编码噪声级差异）
- [x] 6.3 分辨率一致性：同一样式烧录 720p 与 4K，字幕相对大小/位置/背景框比例一致（截帧对比）；384x288 脚本空间保持旧字号观感
- [x] 6.4 预览一致性：通过 CDP 驱动应用实测，JASSUB 预览渲染的背景框/字号与烧录成品观感一致；样式变更（切换预设）实时更新预览；发现并修复两个问题——① jassub 2.5.6 发布包缺失 default.woff2（webpack NormalModuleReplacementPlugin 占位替换）；② libass WASM 内存字体无法解析 .ttc 集合文件（fontResolver 预览侧回退单面 TTF：macOS 用 Arial Unicode MS）；CSS 降级路径保留
- [x] 6.5 输入格式回归：VTT/LRC 走 ASS 管线烧录正常（截帧验证）；ASS 输入维持 subtitles+force_style 原路径（日志验证）；含单引号路径的字幕正常烧录
- [x] 6.6 编码参数：日志验证命令含 `-c:v libx264 -preset medium -crf 18 -movflags +faststart`；moov box 前置（faststart 生效）；4K 日志显示 `resolution adjustment=+2 (height=2160), final crf=20`（另修复：ffprobe 缺失环境用 ffmpeg-static 探测分辨率兜底）；softmux 全流复制不变；烧录结束临时 ASS 文件清理（临时目录为空）
- [x] 6.7 兼容性：无 `backOpacity` 的旧样式按 50%（alpha=128）处理（单元断言 + 渲染层 `?? 50` 兜底），行为与旧版硬编码一致

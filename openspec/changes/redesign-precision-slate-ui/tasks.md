## 1. 主题 token 基座（深/浅色 + 默认深色）

- [x] 1.1 在 `renderer/styles/globals.css` 的 `.dark` 重定义 Precision Slate 深色 token（background/card/popover/secondary/muted/accent/border/input/foreground/muted-foreground 三层中性面 + 1px 描边）
- [x] 1.2 将 `--primary`/`--ring` 设为 Editing Blue（`201 100% 50%` ≈ `#00A3FF`），`--primary-foreground` 设为近黑深蓝（`205 100% 13%` ≈ `#003354`）
- [x] 1.3 在 `:root` 推导 Precision Slate 浅色 token（近白冷底/纯白卡片/`220 13% 90%` 描边/深前景；`--primary` 加深至 `#0070c2`(204 100% 38%) + 白前景）
- [x] 1.4 复核 success/warning/info/destructive 语义色（info 对齐 Editing Blue，其余沿用深/浅色既有 AA 值）
- [x] 1.5 `renderer/tailwind.config.js`：`--radius` 降为 `0.375rem`；扩展 `fontFamily.sans`（system-ui 栈）与 `fontFamily.mono`（系统等宽栈）
- [x] 1.6 新增 `label-caps` 工具样式（11px / 700 / `tracking-wider` / uppercase）+ `tnum` 与下沉内阴影工具类；并在 base 层加 `body { bg-background text-foreground font-sans }`
- [x] 1.7 `renderer/pages/_app.tsx`：`ThemeProvider` 的 `defaultTheme` 由 `system` 改为 `dark`（保留切换与持久化）
- [x] 1.8 自查（构建级）：Tailwind 编译通过、token/字体栈/圆角均正确产出；运行态视觉走查待 `npm run dev` 验证

## 2. 共享基元与外壳

- [x] 2.1 `components/ui/card.tsx`：去 `shadow-sm`，确立 1px 描边 + `rounded-lg` 容器圆角
- [x] 2.2 `components/ui/button.tsx`：default 加顶部内高光（tactile）、secondary 加 1px 工具描边、outline hover 描边转主色；控件圆角 ≈4px（rounded-md）
- [x] 2.3 `components/ui/input.tsx` + `textarea`/`select`：聚焦态描边转主色 + 1px ring（Editing Blue glow），加 `shadow-sunken` 下沉感（仅深色）
- [x] 2.4 `components/ui/badge.tsx`：复核——base 变体已随 token 自动对齐新主色与中性描边，无需结构改动（状态徽章在调用处定制）
- [x] 2.5 `components/Layout.tsx`：侧边栏激活项改为左侧 3px 主色竖条 + `bg-primary/10` 填充 + 文本/图标转主色（替换 `bg-muted`）
- [x] 2.6 `components/Layout.tsx`：头部版本号改等宽（`font-mono`）；品牌名排版沿用
- [x] 2.7 自查：Tailwind 编译验证 token 级联（primary/border/focus 等已正确产出到全局基元）

## 3. 等宽与分区标题落点

- [x] 3.1 时间码等宽：`SubtitleList.tsx` 时间码加 `font-mono`（已含 tabular-nums）、`VideoInfo.tsx` 时长加 `font-mono tabular-nums`；`TimeRangeEditor` 既有 tabular-nums
- [x] 3.2 路径等宽：模型路径展示已为 `font-mono break-all`（`ModelLibrarySection.tsx` 已具备，复核保留）
- [x] 3.3 尺寸/数值等宽：`ModelLibrarySection.tsx` 模型 `model.size`（×2）加 `font-mono`
- [x] 3.4 Key/URL 等宽：`ProviderForm.tsx` 密码(apiKey)输入加 `font-mono`；text 输入对 url/endpoint/host/base/key/token/secret 键名条件 `font-mono`
- [x] 3.5 版本号等宽：`Layout.tsx` 头部（Phase 1）+ `settings.tsx`「关于」版本加 `font-mono`
- [x] 3.6 `label-caps`：`ProvidersTab.tsx` 分组标题（免费/AI/MT）与推荐标题改 `label-caps`（引擎页左栏无独立分组小标题，按现状不强加）

## 4. 品牌资产替换

- [x] 4.1 由「蓝色声波」生成 1024² 源图（`scripts/make_icon.py` 裁出深色 squircle + 透明圆角 → `assets/icon-master-1024.png`），替换 `resources/icon.png`
- [x] 4.2 重生成并替换 `resources/icon.icns`（`iconutil` ← `assets/icon.iconset`）与 `resources/icon.ico`（Pillow 16–256 多尺寸）；含 `docs/static/img/icon.png`
- [x] 4.3 替换应用内 `renderer/public/images/brand/logo-mark.png` 与 `app/images/brand/logo-mark.png`（512² RGBA）
- [x] 4.4 更新 `docs/brand/logo-design-notes.md`（设计概念由 indigo ∞ 环改为蓝色声波 + 生成流水线 + 资产路径核对）
- [x] 4.5 自查：开发态窗口/Dock 图标解析至 `resources/icon.png`（已替换）、侧栏标识用 `/images/brand/logo-mark.png`（已替换）

## 5. 点级打磨与硬编码收口

- [x] 5.1 `pages/[locale]/home.tsx`：启动台 5 张卡片保留差异化彩色；容器/图标 chip 圆角 `rounded-xl`→`rounded-lg` 对齐新 `--radius`，hover 增加 `border-foreground/20` 描边强调（底色/描边本已是语义 token）
- [x] 5.2 `components/resources/ProvidersTab.tsx`：审计确认——除「品牌 logo 白底圆角牌」（`bg-white`+`text-zinc-500`，为保证各主题/选中态下彩色 logo 可辨，属刻意固定面）外，其余均已用语义 token，无主题泄漏类需收口
- [x] 5.3 `components/subtitle/VideoPlayer.tsx`：保留 `bg-black` 视频监看面（Premiere 式 program monitor，刻意固定深底）；占位文案由 `text-zinc-400` 改为语义意图明确的 `text-white/70`（固定深底上的浅色）
- [x] 5.4 对照 `docs/UI/stitch/{engines-models,translation}.png` 走查两页：翻译页（active 项蓝填充+ring、label-caps 分组+chevron、白底 logo 牌、虚线「添加自定义」容器、url/key 等宽）已对齐；引擎页全量语义 token，引擎图标 hex 为各引擎品牌色（与启动台差异化彩色同理保留）；补齐引擎列表 active 项 `ring-primary/20`，与翻译页选中项一致并贴合 stitch 蓝色描边选中卡；「已配置」徽章保留 success 绿（语义状态，design.md 保留 success 语义）为有意偏差

## 6. 验证

- [x] 6.1 `openspec validate redesign-precision-slate-ui --strict` 通过（`Change is valid`）
- [x] 6.2 关键对比度自查达 AA：深色主按钮 5.77、深色蓝前景落底 7.04/落卡 6.39、深色正文 15.68、深色 muted 6.72；浅色主按钮（白字落 `#0070c2`）4.90、浅色蓝前景 4.79、浅色正文 16.61、浅色 muted 5.29（全部 ≥4.5）
- [x] 6.3 零字体成本核验：renderer 无 `@font-face`/`next/font`/`@fontsource`/Google Fonts；`renderer/public` 无 woff/ttf/otf/eot；Tailwind `sans`/`mono` 均为系统栈（system-ui / ui-monospace）
- [x] 6.4 主题装配静态核验：`_app.tsx` `attribute="class" defaultTheme="dark" enableSystem`（默认深色 + 保留浅色切换）；`ThemeToggle.tsx` 存在；`:root` 与 `.dark` 25 个颜色 token 全量对位（仅 `radius`/spacing 等与主题无关的布局 token 仅在 `:root`）；`body` 跟随 `bg-background/text-foreground`。运行态逐页像素走查需 `npm run dev`（GUI，建议人工最终确认）
- [x] 6.5 图标资产级核验：`resources/icon.icns` 含 16→1024 全 10 成员；`resources/icon.ico` 含 16/24/32/48/64/128/256 七尺寸；`resources/icon.png` 1024² RGBA，且为 `resolveAppIcon()`/electron-builder 自动发现源。完整安装包确认需 `electron-builder` 打包（建议人工最终确认）

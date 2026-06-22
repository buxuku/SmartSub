# SmartSub / 妙幕 品牌 Logo

> 更新：2026-06-22（Precision Slate 改版，由 indigo ∞ 环改为蓝色声波）

## 设计概念

- **产品定位**：专业字幕创作台（转写 → 翻译 → 校对 → 合成），本地优先。
- **视觉语言**：与 UI 品牌主色 **Editing-Blue `#00A3FF`**（`--primary`）一致；克制、几何、可小尺寸识别，呼应 Premiere Pro 式专业工具气质。
- **符号构成**（当前选用 **蓝色声波 + 字幕序列**）：
  - 深色磨砂 squircle 底 + 发光的 Editing-Blue 笔刷声波
  - 左侧连续声波笔画 → 右侧规律的字幕虚线/点阵 = **语音转写为字幕**
  - 柔和蓝色辉光，全幅 squircle，几何自信、Figma/Notion 级品牌识别度

## 资产路径

| 用途                    | 路径                                                |
| ----------------------- | --------------------------------------------------- |
| 侧边栏 Logo（开发态）   | `renderer/public/images/brand/logo-mark.png` (512²) |
| 侧边栏 Logo（构建产物） | `app/images/brand/logo-mark.png` (512²)             |
| electron-builder 源图   | `resources/icon.png` (1024²)                        |
| macOS 打包              | `resources/icon.icns`                               |
| Windows 打包            | `resources/icon.ico`（16–256 多尺寸）               |
| 文档站                  | `docs/static/img/icon.png` (1024²)                  |
| 设计母版                | `assets/icon-master-1024.png` (1024² RGBA)          |

## 生成流水线

- 源稿：`docs/UI/logo-alpha.png`（2048²，手工处理）。注意其外发光为「棋盘格抖动」假透明、并带水印，故不能直接当透明图使用。
- 母版：`assets/icon-master-1024.png` —— 由 `scripts/make_icon.py` 提取 squircle 实心轮廓做 alpha：利用「中性灰（R≈G≈B）且非高亮」区分**方块本体（黑面+灰描边）**与**蓝色/白色发光抖动**，凸形按行 span-fill 成实心轮廓后裁成 1024² 透明圆角图。**保留方块真实圆角与描边，不套合成圆角矩形**（避免内容失真），并剔除发光抖动与水印。
- 派生：`scripts/build_icons.py` 由母版批量产出上表中的 PNG / `.ico`（16–256 多尺寸），并写出 `assets/icon.iconset/`；macOS `.icns` 由 `iconutil` 合成。
- 重新生成命令：
  ```bash
  python3 scripts/make_icon.py docs/UI/logo-alpha.png assets/icon-master-1024.png
  python3 scripts/build_icons.py
  iconutil -c icns assets/icon.iconset -o resources/icon.icns
  ```

## 使用

- 图标为 **全幅 squircle**（非旧版 72% 内缩），自带 ~20% 圆角透明边，底色为深色磨砂。
- 桌面图标：由 `electron-builder.yml` → `buildResources: resources` 自动打入安装包。
- 开发态窗口图标：`main/background.ts` → `resolveAppIcon()`（解析到 `resources/icon.png`）。
- 开发态 macOS：`app.setName('SmartSub')` + `app.dock.setIcon()`（否则菜单栏/Dock 显示 Electron 默认）。

## 后续可选

- 导出纯 SVG 矢量版（当前为 raster PNG）。
- 暗色侧栏专用 monochrome 变体（去圆角底图的纯符号版）。

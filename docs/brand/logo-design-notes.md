# SmartSub / 妙幕 品牌 Logo

> 更新：2026-06-13

## 设计概念

- **产品定位**：专业字幕创作台（转写 → 翻译 → 校对 → 合成），本地优先。
- **视觉语言**：与 UI 品牌主色 indigo（`--primary`）一致；克制、几何、可小尺寸识别。
- **符号构成**（当前选用 **第二轮 Option G**）：
  - 电靛蓝底 + 白色粗线条连续笔画
  - ∞ 形环 + 底部字幕虚线 → 转写→翻译→校对的无尽流水线
  - 几何、自信、Figma/Notion 级品牌识别度

## 资产路径

| 用途                  | 路径                                         |
| --------------------- | -------------------------------------------- |
| 侧边栏 Logo           | `renderer/public/images/brand/logo-mark.png` |
| electron-builder 源图 | `resources/icon.png` (1024×1024)             |
| macOS 打包            | `resources/icon.icns`                        |
| Windows 打包          | `resources/icon.ico`                         |
| 文档站                | `docs/static/img/icon.png`                   |

## 使用

- 所有 raster 图标统一 **72% 内缩 + 靛蓝边距**，并加 **~22% 圆角透明边**（与 macOS Dock squircle 一致）。
- 桌面图标：由 `electron-builder.yml` → `buildResources: resources` 自动打入安装包。
- 开发态窗口图标：`main/background.ts` → `resolveAppIcon()`。
- 开发态 macOS：`app.setName('SmartSub')` + `app.dock.setIcon()`（否则菜单栏/Dock 显示 Electron 默认）。

## 后续可选

- 导出纯 SVG 矢量版（当前为 raster PNG）。
- 暗色侧栏专用 monochrome 变体（若未来去掉圆角底图）。

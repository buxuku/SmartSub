/** macOS hiddenInset 交通灯定位（与 main/helpers/windowChrome.ts 保持一致） */
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 14, y: 14 } as const;

/**
 * 侧栏顶区留白：交通灯 y + 按钮组高度（~30px）+ 与 Logo 间距。
 * Sequoia / Tahoe 上按钮略大，取保守值。
 */
export const MAC_SIDEBAR_TRAFFIC_LIGHT_CLEARANCE = 56;

/** Windows / Linux titleBarOverlay 右侧系统按钮占位 */
export const WIN_CAPTION_BUTTONS_WIDTH = 138;

/** 与顶栏 h-11 对齐 */
export const TITLE_BAR_OVERLAY_HEIGHT = 44;

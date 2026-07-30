import {
  BrowserWindow,
  ipcMain,
  type BrowserWindowConstructorOptions,
} from 'electron';
import {
  MAC_TRAFFIC_LIGHT_POSITION,
  TITLE_BAR_OVERLAY_HEIGHT,
  WIN_CAPTION_BUTTONS_WIDTH,
} from '../../types/windowChrome';

export {
  TITLE_BAR_OVERLAY_HEIGHT,
  WIN_CAPTION_BUTTONS_WIDTH,
} from '../../types/windowChrome';

/** 浅色 chrome 面：hsl(216 17% 94%) */
const CHROME_LIGHT = '#e8eaed';
/** 深色 chrome 面：hsl(220 12% 10%) */
const CHROME_DARK = '#181a1e';

function usesTitleBarOverlay(): boolean {
  return process.platform === 'win32' || process.platform === 'linux';
}

/**
 * 隐藏系统原生标题栏，内容延伸至窗口顶缘（沉浸外壳）。
 * - macOS：hiddenInset，保留红黄绿按钮叠在侧栏顶区
 * - Windows / Linux：titleBarStyle hidden + titleBarOverlay，系统按钮叠在顶栏右侧
 */
export function getHiddenNativeTitleBarOptions(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { ...MAC_TRAFFIC_LIGHT_POSITION },
    };
  }

  if (usesTitleBarOverlay()) {
    return {
      // Windows：hidden + overlay 才能去掉原生标题栏条；Linux 同 overlay 路径
      titleBarStyle: 'hidden',
      // Windows：隐藏菜单栏行，避免顶栏下方再出现一行系统菜单
      ...(process.platform === 'win32' ? { autoHideMenuBar: true } : {}),
      titleBarOverlay: getTitleBarOverlayForTheme('dark'),
    };
  }

  return {};
}

/** 供主题切换时同步 Windows/Linux 标题栏叠层颜色 */
export function getTitleBarOverlayForTheme(theme: 'light' | 'dark') {
  return {
    color: theme === 'light' ? CHROME_LIGHT : CHROME_DARK,
    symbolColor: theme === 'light' ? '#1a2332' : '#e8ecf0',
    height: TITLE_BAR_OVERLAY_HEIGHT,
  };
}

/** 渲染进程主题变化时同步标题栏叠层（仅 Win/Linux） */
export function setupWindowChromeHandlers(mainWindow: BrowserWindow): void {
  if (!usesTitleBarOverlay()) return;

  ipcMain.handle(
    'sync-title-bar-overlay',
    (event, theme: 'light' | 'dark' | undefined) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      if (!win || win.isDestroyed()) return;
      const overlayTheme = theme === 'light' ? 'light' : 'dark';
      win.setTitleBarOverlay(getTitleBarOverlayForTheme(overlayTheme));
    },
  );
}

import { app, BrowserWindow, Menu, shell } from 'electron';
import { store } from './store';

type MenuLanguage = 'zh' | 'en';

/**
 * 应用菜单本地化字典。
 * 主进程不引 i18n 运行时，菜单条目有限，直接维护双语字典。
 */
const LABELS: Record<MenuLanguage, Record<string, string>> = {
  zh: {
    about: '关于 %s',
    hide: '隐藏 %s',
    hideOthers: '隐藏其他',
    unhide: '全部显示',
    quit: '退出 %s',
    file: '文件',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    view: '视图',
    reload: '重新加载',
    toggleDevTools: '开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    togglefullscreen: '切换全屏',
    window: '窗口',
    minimize: '最小化',
    close: '关闭窗口',
    help: '帮助',
    checkUpdates: '检查更新…',
    openLogs: '查看日志',
    github: 'GitHub 仓库',
    reportIssue: '反馈问题',
  },
  en: {
    about: 'About %s',
    hide: 'Hide %s',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit %s',
    file: 'File',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    reload: 'Reload',
    toggleDevTools: 'Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    togglefullscreen: 'Toggle Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    close: 'Close Window',
    help: 'Help',
    checkUpdates: 'Check for Updates…',
    openLogs: 'View Logs',
    github: 'GitHub Repository',
    reportIssue: 'Report an Issue',
  },
};

const REPO_URL = 'https://github.com/buxuku/SmartSub';

let mainWindowRef: BrowserWindow | null = null;

function resolveLanguage(): MenuLanguage {
  const settings = store.get('settings') as { language?: string } | undefined;
  if (settings?.language === 'zh' || settings?.language === 'en') {
    return settings.language;
  }
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 发事件给 renderer 前确保窗口可见（菜单可能在窗口隐藏时触发） */
function sendToRenderer(channel: string) {
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) return;
  win.show();
  win.webContents.send(channel);
}

export function buildAppMenu(language: MenuLanguage = resolveLanguage()) {
  const l = LABELS[language];
  const appName = app.name;
  const fmt = (s: string) => s.replace('%s', appName);
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: fmt(l.about) },
        { type: 'separator' },
        { role: 'hide', label: fmt(l.hide) },
        { role: 'hideOthers', label: l.hideOthers },
        { role: 'unhide', label: l.unhide },
        { type: 'separator' },
        { role: 'quit', label: fmt(l.quit) },
      ],
    });
  } else {
    template.push({
      label: l.file,
      submenu: [{ role: 'quit', label: fmt(l.quit) }],
    });
  }

  template.push({
    label: l.edit,
    submenu: [
      { role: 'undo', label: l.undo },
      { role: 'redo', label: l.redo },
      { type: 'separator' },
      { role: 'cut', label: l.cut },
      { role: 'copy', label: l.copy },
      { role: 'paste', label: l.paste },
      { role: 'selectAll', label: l.selectAll },
    ],
  });

  template.push({
    label: l.view,
    submenu: [
      { role: 'reload', label: l.reload },
      { role: 'toggleDevTools', label: l.toggleDevTools },
      { type: 'separator' },
      { role: 'resetZoom', label: l.resetZoom },
      { role: 'zoomIn', label: l.zoomIn },
      { role: 'zoomOut', label: l.zoomOut },
      { type: 'separator' },
      { role: 'togglefullscreen', label: l.togglefullscreen },
    ],
  });

  if (isMac) {
    template.push({
      label: l.window,
      submenu: [
        { role: 'minimize', label: l.minimize },
        { role: 'close', label: l.close },
      ],
    });
  }

  template.push({
    label: l.help,
    submenu: [
      {
        label: l.checkUpdates,
        click: () => sendToRenderer('menu-check-updates'),
      },
      {
        label: l.openLogs,
        click: () => sendToRenderer('menu-open-logs'),
      },
      { type: 'separator' },
      {
        label: l.github,
        click: () => shell.openExternal(REPO_URL),
      },
      {
        label: l.reportIssue,
        click: () => shell.openExternal(`${REPO_URL}/issues`),
      },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function setupAppMenu(mainWindow: BrowserWindow) {
  mainWindowRef = mainWindow;
  buildAppMenu();
}

/** 语言切换后重建菜单（由 setSettings 拦截调用） */
export function rebuildAppMenu(language?: string) {
  buildAppMenu(
    language === 'zh' || language === 'en' ? language : resolveLanguage(),
  );
}

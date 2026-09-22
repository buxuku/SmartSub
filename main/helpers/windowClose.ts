import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { store } from './store';
import { getTranscriptionBusyCount } from './taskProcessor';
import { decideCloseIntent, type CloseAction } from './windowCloseDecision';

type DialogLanguage = 'zh' | 'en';

/** Cmd+Q / 菜单退出 / 我们主动退出时置位：区分「关窗」与「真退出」 */
let isQuitting = false;
/** 防止连点红叉时叠加多个对话框 */
let closePromptOpen = false;
const dirtyWindows = new Set<number>();

export function confirmUnsavedWindows(): boolean {
  return BrowserWindow.getAllWindows().every(
    (win) => !dirtyWindows.has(win.webContents.id) || confirmUnsaved(win),
  );
}

function confirmUnsaved(win: BrowserWindow): boolean {
  const zh = resolveLanguage() === 'zh';
  return (
    dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: zh ? '未保存的修改' : 'Unsaved changes',
      message: zh
        ? '当前工作尚未保存。确定离开吗？'
        : 'Your work has unsaved changes. Leave anyway?',
      detail: zh
        ? '未保存内容已尽可能保留为恢复草稿。'
        : 'Unsaved work is retained as a recovery draft when storage is available.',
      buttons: zh ? ['离开', '继续编辑'] : ['Leave', 'Keep editing'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }) === 0
  );
}

export function getIsQuitting(): boolean {
  return isQuitting;
}

export function markQuitting(): void {
  isQuitting = true;
}

const LABELS: Record<DialogLanguage, Record<string, string>> = {
  zh: {
    bgTitle: '应用仍在后台运行',
    bgDetailBusy:
      '仍在后台处理 %d 个任务。要彻底退出，请用 Cmd+Q 或右键 Dock 图标 → 退出。',
    bgDetailIdle:
      '应用将继续在后台运行。要彻底退出，请用 Cmd+Q 或右键 Dock 图标 → 退出。',
    bgBackground: '转入后台',
    bgQuitNow: '立即退出',
    dontShowAgain: '不再提示',
    quitTitle: '仍有任务在运行',
    quitDetailBusy: '当前还有 %d 个任务正在处理，退出会中断它们。确定退出吗？',
    quitConfirm: '退出',
    cancel: '取消',
  },
  en: {
    bgTitle: 'App keeps running in the background',
    bgDetailBusy:
      'Still processing %d task(s) in the background. To quit completely, use Cmd+Q or right-click the Dock icon → Quit.',
    bgDetailIdle:
      'The app will keep running in the background. To quit completely, use Cmd+Q or right-click the Dock icon → Quit.',
    bgBackground: 'Keep in Background',
    bgQuitNow: 'Quit Now',
    dontShowAgain: "Don't show again",
    quitTitle: 'Tasks still running',
    quitDetailBusy:
      '%d task(s) are still processing. Quitting will interrupt them. Quit anyway?',
    quitConfirm: 'Quit',
    cancel: 'Cancel',
  },
};

function resolveLanguage(): DialogLanguage {
  const settings = store.get('settings') as { language?: string } | undefined;
  if (settings?.language === 'zh' || settings?.language === 'en') {
    return settings.language;
  }
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function resolveCloseAction(): CloseAction {
  const a = (store.get('settings') as { closeAction?: CloseAction } | undefined)
    ?.closeAction;
  return a === 'background' || a === 'quit' ? a : 'smart';
}

/** 二次确认退出：返回 true=用户确认退出 */
function confirmQuit(win: BrowserWindow, count: number): boolean {
  const l = LABELS[resolveLanguage()];
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: [l.quitConfirm, l.cancel],
    defaultId: 1,
    cancelId: 1,
    title: l.quitTitle,
    message: l.quitTitle,
    detail: l.quitDetailBusy.replace('%d', String(count)),
    noLink: true,
  });
  return choice === 0;
}

/**
 * 转入后台：首次弹一次性提示（带「不再提示」+「立即退出」），之后静默隐藏。
 * 返回前已执行 hide 或 app.quit。
 */
async function goBackground(win: BrowserWindow, count: number): Promise<void> {
  const settings = store.get('settings');
  if (settings?.closeHintShown) {
    win.hide();
    return;
  }
  const l = LABELS[resolveLanguage()];
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: [l.bgBackground, l.bgQuitNow],
    defaultId: 0,
    cancelId: 0,
    title: l.bgTitle,
    message: l.bgTitle,
    detail:
      count > 0 ? l.bgDetailBusy.replace('%d', String(count)) : l.bgDetailIdle,
    checkboxLabel: l.dontShowAgain,
    checkboxChecked: false,
    noLink: true,
  });
  if (checkboxChecked) {
    store.set('settings', { ...settings, closeHintShown: true });
  }
  if (response === 1) {
    app.quit();
    return;
  }
  win.hide();
}

async function handleWindowClose(win: BrowserWindow): Promise<void> {
  if (closePromptOpen) return;
  closePromptOpen = true;
  try {
    const count = getTranscriptionBusyCount();
    const intent = decideCloseIntent({
      platform: process.platform,
      closeAction: resolveCloseAction(),
      busy: count > 0,
    });
    if (intent === 'quit') {
      app.quit();
    } else if (intent === 'confirm-quit') {
      if (confirmQuit(win, count)) app.quit();
    } else {
      await goBackground(win, count);
    }
  } finally {
    closePromptOpen = false;
  }
}

/** 装配窗口关闭行为 + Dock 激活恢复（取代 background.ts 内联逻辑） */
export function setupWindowCloseBehavior(mainWindow: BrowserWindow): void {
  const recordDirty = (event: Electron.IpcMainEvent, dirty: boolean) => {
    if (event.sender !== mainWindow.webContents) return;
    if (dirty === true) dirtyWindows.add(event.sender.id);
    else dirtyWindows.delete(event.sender.id);
  };
  ipcMain.on('setUnsavedChanges', recordDirty);
  const contentsId = mainWindow.webContents.id;
  mainWindow.on('closed', () => {
    dirtyWindows.delete(contentsId);
    ipcMain.removeListener('setUnsavedChanges', recordDirty);
  });
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (confirmUnsaved(mainWindow)) event.preventDefault();
  });
  mainWindow.on('close', (e) => {
    if (isQuitting) return; // 真退出进行中：放行
    e.preventDefault();
    void handleWindowClose(mainWindow);
  });

  // macOS：点击 Dock 图标恢复窗口
  app.on('activate', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });
}

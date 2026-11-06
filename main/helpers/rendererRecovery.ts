import type {
  BrowserWindow,
  MessageBoxOptions,
  RenderProcessGoneDetails,
} from 'electron';

/** A native dialog remains usable after the renderer (including React) dies. */
export function setupRendererRecovery(
  window: BrowserWindow,
  options: {
    isQuitting: () => boolean;
    language: () => string;
    showMessageBox: (
      parent: BrowserWindow,
      options: MessageBoxOptions,
    ) => Promise<{ response: number }>;
  },
) {
  let prompting = false;
  const available = () =>
    !options.isQuitting() &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed();
  const recover = async (details: RenderProcessGoneDetails) => {
    // `killed` can also leave a live window blank (including external kills).
    // The window/quit guards distinguish those from an intentional app exit.
    if (prompting || !available() || details.reason === 'clean-exit') return;
    prompting = true;
    try {
      const zh = options.language().toLowerCase().startsWith('zh');
      const { response } = await options.showMessageBox(window, {
        type: 'warning',
        title: zh ? '界面需要恢复' : 'The app window needs to recover',
        message: zh
          ? '界面进程意外退出，可以重新加载界面。'
          : 'The app window stopped unexpectedly. You can reload it.',
        detail: zh
          ? '重新加载界面不会取消后台任务。未保存的编辑可能需要从恢复草稿中找回。'
          : 'Reloading the window does not cancel background tasks. Unsaved edits may need to be restored from a recovery draft.',
        buttons: zh ? ['重新加载界面', '稍后处理'] : ['Reload window', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      // Keep the existing route/project and let the page hydrate authoritative
      // main-process state. Never automatically restart tasks or reload in a loop.
      if (response === 0 && available()) window.webContents.reload();
    } catch (error) {
      console.error('Renderer recovery failed', error);
    } finally {
      prompting = false;
    }
  };
  window.webContents.on('render-process-gone', (_event, details) => {
    void recover(details);
  });
}

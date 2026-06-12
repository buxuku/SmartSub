import { BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { store } from './store';
import { logMessage } from './logger';

// 配置自动更新
autoUpdater.autoDownload = false; // 不自动下载，让用户决定

autoUpdater.autoInstallOnAppQuit = true; // 应用退出时自动安装

// 针对未签名应用的配置
// autoUpdater.allowPrerelease = false; // 允许预发布版本
autoUpdater.forceDevUpdateConfig = true; // 强制使用开发配置，绕过签名验证
// autoUpdater.allowDowngrade = true; // 允许降级安装，有助于解决某些版本问题

// 日志设置
autoUpdater.logger = {
  info: (message) => logMessage(`[Updater] ${message}`, 'info'),
  warn: (message) => logMessage(`[Updater] ${message}`, 'warning'),
  error: (message) => logMessage(`[Updater] ${message}`, 'error'),
  debug: (message) => logMessage(`[Updater] ${message}`, 'info'),
};

import { getBuildInfo } from './buildInfo';

export function setupAutoUpdater(mainWindow: BrowserWindow) {
  // 针对Mac平台的特殊处理
  const isMacOS = process.platform === 'darwin';
  const buildInfo = getBuildInfo(); // buildInfo 仍用于日志记录

  // 如果是Mac平台，禁用自动下载和安装
  if (isMacOS) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
  }

  // 设置更新通道：所有构建（含 beta 等预发布版本）都只跟踪稳定通道。
  // 预发布版本若不显式关闭 allowPrerelease，electron-updater 会从
  // releases.atom（包含未发 release 的裸 tag）解析出 beta tag 自身，
  // 再去请求其名下不存在的 latest-mac.yml 而报 404。
  // 关闭后 beta 安装包静默无更新，待下一个稳定版发布时正常收到提示。
  autoUpdater.channel = 'latest';
  autoUpdater.allowPrerelease = false;
  logMessage(`Setting update channel to: ${autoUpdater.channel}`, 'info');

  // 检查更新（失败反馈统一由 renderer 依据 update-status error 事件呈现）
  const checkForUpdates = async () => {
    try {
      logMessage(
        `Checking for updates... Platform: ${buildInfo.platform}, Arch: ${buildInfo.arch} on channel '${autoUpdater.channel}'`,
        'info',
      );
      const result = await autoUpdater.checkForUpdates();
      return result;
    } catch (error) {
      logMessage(`Error checking for updates: ${error.message}`, 'error');
      return null;
    }
  };

  // 设置自动更新事件处理
  autoUpdater.on('checking-for-update', () => {
    mainWindow.webContents.send('update-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    // 只通知渲染进程，不弹出系统对话框，由渲染进程的 UpdateDialog 组件处理
    mainWindow.webContents.send('update-status', {
      status: 'available',
      version: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow.webContents.send('update-status', { status: 'not-available' });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow.webContents.send('update-status', {
      status: 'downloading',
      progress: progressObj.percent,
    });
  });

  // 安装提示仅由 renderer 的 toast（带「立即安装」动作）承担，不再叠加原生 dialog
  autoUpdater.on('update-downloaded', (info) => {
    mainWindow.webContents.send('update-status', {
      status: 'downloaded',
      version: info.version,
    });
  });

  autoUpdater.on('error', (error) => {
    logMessage(`Update error: ${error.message}`, 'error'); // Restored original log message for error
    mainWindow.webContents.send('update-status', {
      status: 'error',
      error: error.message,
    });

    // 当自动更新出错时，提供手动下载选项
    // if (process.platform === 'darwin') {
    //   // 针对Mac平台的特殊处理
    //   dialog
    //     .showMessageBox(mainWindow, {
    //       type: 'info',
    //       title: '更新失败',
    //       message: '自动更新失败',
    //       detail:
    //         '由于macOS系统限制，自动更新失败。您可以手动下载并安装最新版本。',
    //       buttons: ['手动下载', '取消'],
    //       cancelId: 1,
    //     })
    //     .then(({ response }) => {
    //       if (response === 0) {
    //         // 打开GitHub发布页面，让用户手动下载
    //         const releaseUrl =
    //           'https://github.com/buxuku/SmartSub/releases/latest';
    //         require('electron').shell.openExternal(releaseUrl);
    //       }
    //     });
    // }
  });

  // 设置IPC处理程序
  ipcMain.handle('check-for-updates', async () => {
    return checkForUpdates();
  });

  ipcMain.handle('download-update', async () => {
    // 针对Mac平台的特殊处理
    if (process.platform === 'darwin') {
      // 打开GitHub发布页面，让用户手动下载
      const releaseUrl = 'https://github.com/buxuku/SmartSub/releases/latest';
      require('electron').shell.openExternal(releaseUrl);
      return { success: true, manualDownload: true };
    }

    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      logMessage(`Error downloading update: ${error.message}`, 'error');
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('install-update', async () => {
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  });

  // 启动时检查更新（可选，根据用户设置）
  const settings = store.get('settings');
  const checkUpdateOnStartup = settings?.checkUpdateOnStartup !== false; // 默认为true

  if (checkUpdateOnStartup) {
    // 延迟几秒检查更新，让应用先启动完成
    setTimeout(() => {
      checkForUpdates();
    }, 5000);
  }

  return {
    checkForUpdates,
  };
}

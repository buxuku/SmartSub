import { app, BrowserWindow, ipcMain, dialog } from 'electron';
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

  // 设置更新通道
  autoUpdater.channel = 'latest'; // 直接将 channel 设置为 'latest'
  logMessage(`Setting update channel to: ${autoUpdater.channel}`, 'info');

  // 检查更新
  const checkForUpdates = async (silent = false) => {
    try {
      logMessage(
        `Checking for updates... Platform: ${buildInfo.platform}, Arch: ${buildInfo.arch} on channel '${autoUpdater.channel}'`,
        'info',
      );
      const result = await autoUpdater.checkForUpdates();
      return result;
    } catch (error) {
      logMessage(`Error checking for updates: ${error.message}`, 'error');
      if (!silent) {
        dialog.showErrorBox('更新检查失败', `检查更新时出错: ${error.message}`);
      }
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

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow.webContents.send('update-status', {
      status: 'downloaded',
      version: info.version,
    });

    // 提示用户安装更新
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: '更新已下载',
        message: '更新已下载完成',
        detail: '已下载新版本，是否立即安装并重启应用？',
        buttons: ['立即安装', '稍后安装'],
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          // 用户选择立即安装
          autoUpdater.quitAndInstall(false, true);
        }
      });
  });

  autoUpdater.on('error', (error) => {
    logMessage(`Update error: ${error.message}`, 'error'); // Restored original log message for error
    mainWindow.webContents.send('update-status', {
      status: 'error',
      error: error.message,
    });

    // 当自动更新出错时，提供手动下载选项
    if (process.platform === 'darwin') {
      // 针对Mac平台的特殊处理
      dialog
        .showMessageBox(mainWindow, {
          type: 'info',
          title: '更新失败',
          message: '自动更新失败',
          detail:
            '由于macOS系统限制，自动更新失败。您可以手动下载并安装最新版本。',
          buttons: ['手动下载', '取消'],
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) {
            // 打开GitHub发布页面，让用户手动下载
            const releaseUrl =
              'https://github.com/buxuku/SmartSub/releases/latest';
            require('electron').shell.openExternal(releaseUrl);
          }
        });
    }
  });

  // 设置IPC处理程序
  ipcMain.handle('check-for-updates', async (event, silent = false) => {
    return checkForUpdates(silent);
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
      checkForUpdates(true); // 静默检查
    }, 5000);
  }

  return {
    checkForUpdates,
  };
}

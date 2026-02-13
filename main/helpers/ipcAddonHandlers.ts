import { ipcMain, BrowserWindow, dialog } from 'electron';
import { logMessage } from './storeManager';
import { getCudaEnvironment, isPlatformCudaCapable } from './cudaUtils';
import {
  getAddonConfig,
  getInstalledAddons,
  getSelectedAddonVersion,
  selectAddonVersion,
  removeAddon,
  registerInstalledAddon,
  getAddonSummary,
  setCustomAddonPath,
  getCustomAddonPath,
} from './addonManager';
import {
  getAddonDownloader,
  getDownloadUrl,
  getAddonFileName,
} from './addonDownloader';
import {
  fetchRemoteVersions,
  checkAllUpdates,
  getRemoteVersionInfo,
} from './addonVersions';
import type {
  CudaVersion,
  DownloadSource,
  DownloadConfig,
} from '../../types/addon';

let mainWindow: BrowserWindow | null = null;

/**
 * 设置主窗口引用
 */
export function setMainWindowForAddon(window: BrowserWindow): void {
  mainWindow = window;
  getAddonDownloader(window);
}

/**
 * 注册所有加速包相关的 IPC 处理程序
 */
export function registerAddonIpcHandlers(): void {
  // 获取 CUDA 环境信息
  ipcMain.handle('get-cuda-environment', async () => {
    try {
      const env = getCudaEnvironment();
      return env;
    } catch (error) {
      logMessage(`Error getting CUDA environment: ${error}`, 'error');
      return null;
    }
  });

  // 获取已安装的加速包列表
  ipcMain.handle('get-installed-addons', async () => {
    try {
      return getInstalledAddons();
    } catch (error) {
      logMessage(`Error getting installed addons: ${error}`, 'error');
      return [];
    }
  });

  // 获取加速包配置
  ipcMain.handle('get-addon-config', async () => {
    try {
      return getAddonConfig();
    } catch (error) {
      logMessage(`Error getting addon config: ${error}`, 'error');
      return null;
    }
  });

  // 获取当前选中的加速包版本
  ipcMain.handle('get-selected-addon-version', async () => {
    try {
      return getSelectedAddonVersion();
    } catch (error) {
      logMessage(`Error getting selected addon version: ${error}`, 'error');
      return null;
    }
  });

  // 选择加速包版本
  ipcMain.handle(
    'select-addon-version',
    async (event, version: CudaVersion) => {
      try {
        selectAddonVersion(version);
        return { success: true };
      } catch (error) {
        logMessage(`Error selecting addon version: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 开始下载加速包（立即返回，不等待下载完成）
  ipcMain.handle(
    'start-addon-download',
    async (event, config: DownloadConfig) => {
      try {
        const downloader = getAddonDownloader(mainWindow || undefined);

        // 异步启动下载，不等待完成
        downloader
          .download(config.source, config.cudaVersion, config.type)
          .then(async () => {
            // 下载完成后注册加速包并自动选中
            const remoteInfo = await getRemoteVersionInfo(config.cudaVersion);
            registerInstalledAddon(
              config.cudaVersion,
              remoteInfo?.version ||
                new Date().toISOString().split('T')[0].replace(/-/g, '.'),
            );
            // 自动选中刚下载的版本
            selectAddonVersion(config.cudaVersion);
            logMessage(
              `Addon ${config.cudaVersion} downloaded and selected`,
              'info',
            );
          })
          .catch((error) => {
            logMessage(`Download failed: ${error}`, 'error');
          });

        // 立即返回，表示下载已启动
        return { success: true, started: true };
      } catch (error) {
        logMessage(`Error starting addon download: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 取消下载
  ipcMain.handle('cancel-addon-download', async () => {
    try {
      const downloader = getAddonDownloader();
      downloader.cancel();
      return { success: true };
    } catch (error) {
      logMessage(`Error cancelling download: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

  // 删除加速包
  ipcMain.handle('remove-addon', async (event, version: CudaVersion) => {
    try {
      await removeAddon(version);
      return { success: true };
    } catch (error) {
      logMessage(`Error removing addon: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

  // 检查加速包更新
  ipcMain.handle('check-addon-updates', async () => {
    try {
      const updates = await checkAllUpdates();
      return updates;
    } catch (error) {
      logMessage(`Error checking addon updates: ${error}`, 'error');
      return [];
    }
  });

  // 获取远程版本信息
  ipcMain.handle('get-remote-addon-versions', async () => {
    try {
      return await fetchRemoteVersions();
    } catch (error) {
      logMessage(`Error fetching remote versions: ${error}`, 'error');
      return null;
    }
  });

  // 获取加速包摘要信息
  ipcMain.handle('get-addon-summary', async () => {
    try {
      return getAddonSummary();
    } catch (error) {
      logMessage(`Error getting addon summary: ${error}`, 'error');
      return {
        hasInstalled: false,
        selectedVersion: null,
        installedCount: 0,
        installedVersions: [],
      };
    }
  });

  // 检查平台是否支持 CUDA
  ipcMain.handle('is-platform-cuda-capable', async () => {
    return isPlatformCudaCapable();
  });

  // 获取下载 URL（用于显示或手动下载）
  ipcMain.handle(
    'get-addon-download-url',
    async (
      event,
      {
        source,
        cudaVersion,
        type,
      }: {
        source: DownloadSource;
        cudaVersion: CudaVersion;
        type: 'node.gz' | 'tar.gz';
      },
    ) => {
      try {
        return getDownloadUrl(source, cudaVersion, type);
      } catch (error) {
        return null;
      }
    },
  );

  // 选择自定义 addon.node 文件
  ipcMain.handle('select-addon-file', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: 'Select addon.node file',
        filters: [
          {
            name: 'Node Addon',
            extensions: ['node'],
          },
        ],
      });

      if (result.canceled || !result.filePaths[0]) {
        return { filePath: null, canceled: true };
      }

      return { filePath: result.filePaths[0], canceled: false };
    } catch (error) {
      logMessage(`Error selecting addon file: ${error}`, 'error');
      return { filePath: null, canceled: true, error: String(error) };
    }
  });

  // 设置自定义 addon.node 路径
  ipcMain.handle(
    'set-custom-addon-path',
    async (event, filePath: string | null) => {
      try {
        setCustomAddonPath(filePath);
        return { success: true };
      } catch (error) {
        logMessage(`Error setting custom addon path: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 获取自定义 addon.node 路径
  ipcMain.handle('get-custom-addon-path', async () => {
    try {
      return getCustomAddonPath();
    } catch (error) {
      logMessage(`Error getting custom addon path: ${error}`, 'error');
      return null;
    }
  });

  logMessage('Addon IPC handlers registered', 'info');
}

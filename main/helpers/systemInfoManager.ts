import { ipcMain, BrowserWindow, dialog } from 'electron';
import os from 'os';
import { getModelsInstalled, getPath, deleteModel } from './whisper';
import { getModelDownloader } from './modelDownloader';
import fse from 'fs-extra';
import path from 'path';
import { getTempDir } from './fileUtils';
import { logMessage } from './storeManager';
import { testTranslation } from '../translate';
import { getBuildInfo } from './buildInfo';
import { fetchOpenRouterTranscriptionModels } from './transcription/openRouter';

let downloadingModels = new Set<string>();

export function setupSystemInfoManager(mainWindow: BrowserWindow) {
  const modelDownloader = getModelDownloader(mainWindow);

  ipcMain.handle('getSystemInfo', async () => {
    return {
      modelsInstalled: getModelsInstalled(),
      modelsPath: getPath('modelsPath'),
      downloadingModels: Array.from(downloadingModels),
      buildInfo: getBuildInfo(),
      totalMemoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
    };
  });

  ipcMain.handle('deleteModel', async (event, modelName) => {
    await deleteModel(modelName?.toLowerCase());
    return true;
  });

  ipcMain.handle(
    'downloadModel',
    async (event, { model, source, needsCoreML }) => {
      if (downloadingModels.size > 0) {
        return { success: false, error: 'anotherDownloadInProgress' };
      }

      downloadingModels.add(model);
      try {
        await modelDownloader.download(
          model?.toLowerCase(),
          source,
          needsCoreML,
        );
        downloadingModels.delete(model);
        return { success: true };
      } catch (error) {
        logMessage(`Model download error: ${error}`, 'error');
        downloadingModels.delete(model);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle('cancelModelDownload', async () => {
    modelDownloader.cancel();
    downloadingModels.clear();
    return true;
  });

  ipcMain.handle('importModel', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Model Files', extensions: ['bin', 'mlmodelc'] }],
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const sourcePath = result.filePaths[0];
      const fileName = path.basename(sourcePath);
      const destPath = path.join(getPath('modelsPath'), fileName);

      try {
        await fse.copy(sourcePath, destPath);
        return true;
      } catch (error) {
        console.error('导入模型失败:', error);
        return false;
      }
    }

    return false;
  });

  // 获取临时目录路径
  ipcMain.handle('getTempDir', async () => {
    return getTempDir();
  });

  ipcMain.handle('getOpenRouterTranscriptionModels', async () => {
    try {
      const models = await fetchOpenRouterTranscriptionModels();
      return { success: true, data: models };
    } catch (error) {
      logMessage(`OpenRouter model discovery error: ${error}`, 'warning');
      return { success: false, error: String(error), data: [] };
    }
  });

  // 清除缓存
  ipcMain.handle('clearCache', async () => {
    try {
      const tempDir = getTempDir();
      const files = await fse.readdir(tempDir);

      // 只删除 .wav 文件，保留目录结构
      for (const file of files) {
        if (file.endsWith('.wav') || file.endsWith('.srt')) {
          const filePath = path.join(tempDir, file);
          await fse.unlink(filePath);
          logMessage(`Deleted cache file: ${filePath}`, 'info');
        }
      }

      return true;
    } catch (error) {
      logMessage(`Failed to clear cache: ${error}`, 'error');
      return false;
    }
  });

  ipcMain.handle('testTranslation', async (_, args) => {
    const { provider, sourceLanguage, targetLanguage } = args;
    try {
      return await testTranslation(provider, sourceLanguage, targetLanguage);
    } catch (error) {
      throw error;
    }
  });
}

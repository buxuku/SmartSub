import { ipcMain, BrowserWindow, dialog } from 'electron';
import {
  getModelsInstalled,
  getPath,
  deleteModel,
  downloadModelSync,
} from './whisper';
import fse from 'fs-extra';
import path from 'path';
import { getTempDir } from './fileUtils';
import { logMessage } from './storeManager';
import { testTranslation } from '../translate';
import { getBuildInfo } from './buildInfo';

let downloadingModels = new Set<string>();

export function setupSystemInfoManager(mainWindow: BrowserWindow) {
  ipcMain.handle('getSystemInfo', async () => {
    return {
      modelsInstalled: getModelsInstalled(),
      modelsPath: getPath('modelsPath'),
      downloadingModels: Array.from(downloadingModels),
      buildInfo: getBuildInfo(),
    };
  });

  ipcMain.handle('deleteModel', async (event, modelName) => {
    await deleteModel(modelName?.toLowerCase());
    return true;
  });

  ipcMain.handle(
    'downloadModel',
    async (event, { model, source, needsCoreML }) => {
      if (downloadingModels.has(model)) {
        return false; // 如果模型已经在下载中，则返回 false
      }

      downloadingModels.add(model);
      const onProcess = (progress: number, message: string) => {
        if (progress > 0.0) {
          event.sender.send('downloadProgress', model, progress);
        }
        if (message?.includes?.('Done') || message?.includes?.('main')) {
          event.sender.send('downloadProgress', model, 1);
        }
      };
      try {
        await downloadModelSync(
          model?.toLowerCase(),
          source,
          onProcess,
          needsCoreML,
        );
        downloadingModels.delete(model);
        return true;
      } catch (error) {
        event.sender.send('message', 'download error, please try again');
        downloadingModels.delete(model);
        return false;
      }
    },
  );

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

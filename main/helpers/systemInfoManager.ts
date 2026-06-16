import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import os from 'os';
import { getModelsInstalled, getPath, deleteModel } from './whisper';
import {
  getFasterWhisperModelsInstalled,
  getFasterWhisperModelsPath,
} from './modelCatalog';
import { resolveTranscriptionEngine } from './transcriptionEngine';
import {
  isPyBaseReady,
  isEnginePackageInstalled,
  readEngineManifest,
} from './pythonRuntime/paths';
import type { EngineStatus } from '../../types/engine';
import { store } from './storeManager';
import { getModelDownloader } from './modelDownloader';
import {
  getCt2ProgressKey,
  getFasterWhisperModelDownloader,
  deleteCt2Model,
} from './fasterWhisperModelDownloader';
import {
  getFunasrModelDownloader,
  getFunasrProgressKey,
} from './funasrModelDownloader';
import {
  FUNASR_MODELS,
  FunasrModelId,
  isFunasrModelInstalled,
  isFunasrReady,
  deleteFunasrModel,
  getInstalledFunasrAsrModels,
  getFunasrModelsRoot,
} from './funasrModelCatalog';
import { shutdownPythonRuntime } from './pythonRuntime';
import fse from 'fs-extra';
import path from 'path';
import { getTempDir } from './fileUtils';
import { logMessage } from './storeManager';
import { testTranslation } from '../translate';
import { getBuildInfo } from './buildInfo';

let downloadingModels = new Set<string>();

export function setupSystemInfoManager(mainWindow: BrowserWindow) {
  const modelDownloader = getModelDownloader(mainWindow);
  const ct2ModelDownloader = getFasterWhisperModelDownloader(mainWindow);
  const funasrModelDownloader = getFunasrModelDownloader(mainWindow);

  ipcMain.handle('getSystemInfo', async () => {
    // 三层就绪判定：缺基座 → error（需重装/升级 App）；有基座缺引擎包 → not_installed
    // （资源中心可下载）；两者皆备 → ready。让 UI 能区分两种失败原因。
    const pyBaseReady = isPyBaseReady();
    const pythonEngineStatus: EngineStatus = !pyBaseReady
      ? { state: 'error', message: 'Python base runtime missing' }
      : isEnginePackageInstalled('faster-whisper')
        ? {
            state: 'ready',
            version: readEngineManifest('faster-whisper')?.version,
          }
        : { state: 'not_installed' };
    return {
      modelsInstalled: getModelsInstalled(),
      modelsPath: getPath('modelsPath'),
      downloadingModels: Array.from(downloadingModels),
      buildInfo: getBuildInfo(),
      totalMemoryGB: Math.round(os.totalmem() / (1024 * 1024 * 1024)),
      fasterWhisperModelsInstalled: getFasterWhisperModelsInstalled(),
      fasterWhisperModelsPath: getFasterWhisperModelsPath(),
      transcriptionEngine: resolveTranscriptionEngine(store.get('settings')),
      pythonEngineStatus,
      funasrEngineInstalled: isEnginePackageInstalled('funasr'),
      funasrVadInstalled: isFunasrModelInstalled('silero-vad'),
      funasrAsrModelsInstalled: getInstalledFunasrAsrModels(),
    };
  });

  ipcMain.handle('deleteModel', async (event, modelName) => {
    await deleteModel(modelName?.toLowerCase());
    return true;
  });

  ipcMain.handle('deleteCt2Model', async (_event, modelId) => {
    deleteCt2Model(modelId);
    await shutdownPythonRuntime();
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

  ipcMain.handle('downloadCt2Model', async (_event, { model, source }) => {
    if (downloadingModels.size > 0) {
      return { success: false, error: 'anotherDownloadInProgress' };
    }

    const progressKey = getCt2ProgressKey(model);
    downloadingModels.add(progressKey);
    try {
      await ct2ModelDownloader.download(model, source || 'hf-mirror');
      downloadingModels.delete(progressKey);
      return { success: true };
    } catch (error) {
      logMessage(`CT2 model download error: ${error}`, 'error');
      downloadingModels.delete(progressKey);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle(
    'downloadFunasrModel',
    async (
      _event,
      { model, source }: { model: FunasrModelId; source?: string },
    ) => {
      if (downloadingModels.size > 0) {
        return { success: false, error: 'anotherDownloadInProgress' };
      }
      const progressKey = getFunasrProgressKey(model);
      downloadingModels.add(progressKey);
      try {
        await funasrModelDownloader.download(model, source || 'hf-mirror');
        downloadingModels.delete(progressKey);
        return { success: true };
      } catch (error) {
        logMessage(`funasr model download error: ${error}`, 'error');
        downloadingModels.delete(progressKey);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle('getFunasrModelStatus', async () => ({
    success: true,
    baseReady: isPyBaseReady(),
    engineInstalled: isEnginePackageInstalled('funasr'),
    ready: isFunasrReady(),
    models: (Object.keys(FUNASR_MODELS) as FunasrModelId[]).map((id) => ({
      id,
      installed: isFunasrModelInstalled(id),
    })),
  }));

  ipcMain.handle(
    'deleteFunasrModel',
    async (_event, modelId: FunasrModelId) => {
      try {
        deleteFunasrModel(modelId);
        await shutdownPythonRuntime();
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle('cancelModelDownload', async () => {
    modelDownloader.cancel();
    ct2ModelDownloader.cancel();
    funasrModelDownloader.cancel();
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
        return { success: true };
      } catch (error) {
        console.error('导入模型失败:', error);
        return { success: false, error: String(error) };
      }
    }

    return { success: false, canceled: true };
  });

  ipcMain.handle(
    'openModelsFolder',
    async (_event, options?: { pathType?: 'ggml' | 'ct2' | 'funasr' }) => {
      const modelsPath =
        options?.pathType === 'ct2'
          ? getFasterWhisperModelsPath()
          : options?.pathType === 'funasr'
            ? getFunasrModelsRoot()
            : (getPath('modelsPath') as string);
      try {
        await fse.ensureDir(modelsPath);
        const err = await shell.openPath(modelsPath);
        if (err) {
          return { success: false, error: err };
        }
        return { success: true };
      } catch (error) {
        logMessage(`Failed to open models folder: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  // 获取临时目录路径
  ipcMain.handle('getTempDir', async () => {
    return getTempDir();
  });

  // 清除缓存
  ipcMain.handle('clearCache', async () => {
    try {
      const tempDir = getTempDir();
      const files = await fse.readdir(tempDir);

      // 删除临时音频/字幕缓存与字幕保存备份，保留目录结构
      for (const file of files) {
        if (
          file.endsWith('.wav') ||
          file.endsWith('.srt') ||
          file.endsWith('.bak')
        ) {
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

import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import os from 'os';
import { getModelsInstalled, getPath, deleteModel } from './whisper';
import {
  getFasterWhisperModelsInstalled,
  getFasterWhisperModelsPath,
  toCt2CacheDirName,
} from './modelCatalog';
import {
  validateModelLayout,
  CT2_REQUIRED_FILES,
  CT2_IMPORT_SNAPSHOT_REV,
} from './modelImport';
import {
  isRuntimeInstalled,
  readEngineManifest,
  getEngineDownloadUrl,
  normalizePyEngineVariant,
} from './pythonRuntime/paths';
import { getHfHost, getModelScopeBase } from './config/downloadConfig';
import type { EngineStatus, PyEngineVariant } from '../../types/engine';
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
  isFunasrVadInstalled,
  isFunasrReady,
  deleteFunasrModel,
  getInstalledFunasrAsrModels,
  getFunasrModelsRoot,
} from './funasrModelCatalog';
import {
  getQwenModelDownloader,
  getQwenProgressKey,
} from './qwenModelDownloader';
import {
  QWEN_MODELS,
  QwenModelId,
  QWEN_DEFAULT_MODEL_ID,
  QwenModelSource,
  isQwenModelInstalled,
  isQwenVadInstalled,
  isQwenReady,
  deleteQwenModel,
  getInstalledQwenModels,
  getQwenModelsRoot,
  getQwenArchiveUrl,
} from './qwenModelCatalog';
import {
  getFireRedModelDownloader,
  getFireRedProgressKey,
} from './fireRedModelDownloader';
import {
  FIRERED_MODELS,
  FireRedModelId,
  FIRERED_DEFAULT_MODEL_ID,
  FireRedModelSource,
  isFireRedModelInstalled,
  isFireRedVadInstalled,
  isFireRedReady,
  deleteFireRedModel,
  getInstalledFireRedModels,
  getFireRedModelsRoot,
  getFireRedArchiveUrl,
} from './fireRedModelCatalog';
import { getTtsModelDownloader, getTtsProgressKey } from './ttsModelDownloader';
import {
  TTS_MODELS,
  TtsModelId,
  TTS_DEFAULT_MODEL_ID,
  TtsModelSource,
  isTtsModelInstalled,
  deleteTtsModel,
  getTtsModelsRoot,
  getTtsArchiveUrl,
} from './ttsModelCatalog';
import { shutdownPythonRuntime } from './pythonRuntime';
import { isSherpaLibInstalled } from './sherpaOnnx/sherpaLibPaths';
import { getSherpaAsrRuntime } from './sherpaOnnx/sherpaFunasrRuntime';
import { getSherpaTtsRuntime } from './sherpaOnnx/ttsRuntime';
import fse from 'fs-extra';
import path from 'path';
import { getTempDir } from './fileUtils';
import { logMessage } from './storeManager';
import { testTranslation } from '../translate';
import { getBuildInfo } from './buildInfo';

let downloadingModels = new Set<string>();

/** 可文件夹导入的引擎类型（builtin 走单文件导入，不在此列）。 */
type FolderImportEngine =
  | 'funasr'
  | 'qwen'
  | 'fireRedAsr'
  | 'fasterWhisper'
  | 'tts';

interface ImportPlan {
  /** 目标模型必需文件（相对源/目的目录），用于导入前后布局校验。 */
  requiredFiles: string[];
  /** 拷贝目的地（绝对路径）。 */
  destDir: string;
}

/**
 * 解析「从文件夹导入」的校验集与目的地（按指定引擎+模型槽消歧）。
 * - sherpa 三引擎：落 `<engine root>/<dirName>`，校验集取 catalog requiredFiles；
 * - fasterWhisper：落合成快照目录，使 resolveCt2ModelSnapshotDir 命中，校验集为 CT2 关键文件。
 * 返回 null 表示模型 id 非法/缺失。
 */
function resolveImportPlan(
  engine: FolderImportEngine,
  modelId: string | undefined,
): ImportPlan | null {
  if (engine === 'funasr') {
    const id = modelId as FunasrModelId | undefined;
    if (!id || !FUNASR_MODELS[id]) return null;
    return {
      requiredFiles: FUNASR_MODELS[id].requiredFiles,
      destDir: path.join(getFunasrModelsRoot(), FUNASR_MODELS[id].dirName),
    };
  }
  if (engine === 'qwen') {
    const id = (modelId as QwenModelId) || QWEN_DEFAULT_MODEL_ID;
    if (!QWEN_MODELS[id]) return null;
    return {
      requiredFiles: QWEN_MODELS[id].requiredFiles,
      destDir: path.join(getQwenModelsRoot(), QWEN_MODELS[id].dirName),
    };
  }
  if (engine === 'fireRedAsr') {
    const id = (modelId as FireRedModelId) || FIRERED_DEFAULT_MODEL_ID;
    if (!FIRERED_MODELS[id]) return null;
    return {
      requiredFiles: FIRERED_MODELS[id].requiredFiles,
      destDir: path.join(getFireRedModelsRoot(), FIRERED_MODELS[id].dirName),
    };
  }
  if (engine === 'fasterWhisper') {
    if (!modelId) return null;
    return {
      requiredFiles: CT2_REQUIRED_FILES,
      destDir: path.join(
        getFasterWhisperModelsPath(),
        toCt2CacheDirName(modelId),
        'snapshots',
        CT2_IMPORT_SNAPSHOT_REV,
      ),
    };
  }
  if (engine === 'tts') {
    const id = (modelId as TtsModelId) || TTS_DEFAULT_MODEL_ID;
    if (!TTS_MODELS[id]) return null;
    return {
      requiredFiles: TTS_MODELS[id].requiredFiles,
      destDir: path.join(getTtsModelsRoot(), TTS_MODELS[id].dirName),
    };
  }
  return null;
}

export function setupSystemInfoManager(mainWindow: BrowserWindow) {
  const modelDownloader = getModelDownloader(mainWindow);
  const ct2ModelDownloader = getFasterWhisperModelDownloader(mainWindow);
  const funasrModelDownloader = getFunasrModelDownloader(mainWindow);
  const qwenModelDownloader = getQwenModelDownloader(mainWindow);
  const fireRedModelDownloader = getFireRedModelDownloader(mainWindow);
  const ttsModelDownloader = getTtsModelDownloader(mainWindow);

  ipcMain.handle('getSystemInfo', async () => {
    // faster-whisper 自包含运行时：已落盘 → ready（附 manifest 版本）；
    // 否则 not_installed（资源中心可下载）。运行时探活推迟到真正转写时进行。
    const pythonEngineStatus: EngineStatus = isRuntimeInstalled(
      'faster-whisper',
    )
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
      pythonEngineStatus,
      funasrEngineInstalled: isSherpaLibInstalled(),
      funasrVadInstalled: isFunasrVadInstalled(),
      funasrAsrModelsInstalled: getInstalledFunasrAsrModels(),
      funasrModelsPath: getFunasrModelsRoot(),
      qwenEngineInstalled: isSherpaLibInstalled(),
      qwenVadInstalled: isQwenVadInstalled(),
      qwenModelsInstalled: getInstalledQwenModels(),
      qwenModelsPath: getQwenModelsRoot(),
      fireRedEngineInstalled: isSherpaLibInstalled(),
      fireRedVadInstalled: isFireRedVadInstalled(),
      fireRedModelsInstalled: getInstalledFireRedModels(),
      fireRedModelsPath: getFireRedModelsRoot(),
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
    baseReady: isSherpaLibInstalled(),
    engineInstalled: isSherpaLibInstalled(),
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

  ipcMain.handle(
    'downloadQwenModel',
    async (
      _event,
      { model, source }: { model: QwenModelId; source?: QwenModelSource },
    ) => {
      if (downloadingModels.size > 0) {
        return { success: false, error: 'anotherDownloadInProgress' };
      }
      const progressKey = getQwenProgressKey(model);
      downloadingModels.add(progressKey);
      try {
        await qwenModelDownloader.download(model, source);
        downloadingModels.delete(progressKey);
        return { success: true };
      } catch (error) {
        logMessage(`qwen model download error: ${error}`, 'error');
        downloadingModels.delete(progressKey);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle('getQwenModelStatus', async () => ({
    success: true,
    engineInstalled: isSherpaLibInstalled(),
    vadInstalled: isQwenVadInstalled(),
    ready: isQwenReady(),
    models: (Object.keys(QWEN_MODELS) as QwenModelId[]).map((id) => ({
      id,
      installed: isQwenModelInstalled(id),
    })),
  }));

  ipcMain.handle('deleteQwenModel', async (_event, modelId: QwenModelId) => {
    try {
      // Qwen 与 funasr 共享同一 sherpa worker：删除前先释放 worker，避免 Windows 上
      // 大模型文件被加载占用导致 rm 失败（worker 会在下次转写/预热时自动重建）。
      getSherpaAsrRuntime().dispose();
      deleteQwenModel(modelId);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle(
    'downloadFireRedModel',
    async (
      _event,
      { model, source }: { model: FireRedModelId; source?: FireRedModelSource },
    ) => {
      if (downloadingModels.size > 0) {
        return { success: false, error: 'anotherDownloadInProgress' };
      }
      const progressKey = getFireRedProgressKey(model);
      downloadingModels.add(progressKey);
      try {
        await fireRedModelDownloader.download(model, source);
        downloadingModels.delete(progressKey);
        return { success: true };
      } catch (error) {
        logMessage(`firered model download error: ${error}`, 'error');
        downloadingModels.delete(progressKey);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle('getFireRedModelStatus', async () => ({
    success: true,
    engineInstalled: isSherpaLibInstalled(),
    vadInstalled: isFireRedVadInstalled(),
    ready: isFireRedReady(),
    models: (Object.keys(FIRERED_MODELS) as FireRedModelId[]).map((id) => ({
      id,
      installed: isFireRedModelInstalled(id),
    })),
  }));

  ipcMain.handle(
    'deleteFireRedModel',
    async (_event, modelId: FireRedModelId) => {
      try {
        // fireRed 与 funasr/qwen 共享同一 sherpa worker：删除前先释放 worker，避免 Windows 上
        // 大模型文件被加载占用导致 rm 失败（worker 会在下次转写/预热时自动重建）。
        getSherpaAsrRuntime().dispose();
        deleteFireRedModel(modelId);
        return { success: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'downloadTtsModel',
    async (
      _event,
      { model, source }: { model: TtsModelId; source?: TtsModelSource },
    ) => {
      if (downloadingModels.size > 0) {
        return { success: false, error: 'anotherDownloadInProgress' };
      }
      const progressKey = getTtsProgressKey(model);
      downloadingModels.add(progressKey);
      try {
        await ttsModelDownloader.download(model, source);
        downloadingModels.delete(progressKey);
        return { success: true };
      } catch (error) {
        logMessage(`tts model download error: ${error}`, 'error');
        downloadingModels.delete(progressKey);
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle('getTtsModelStatus', async () => ({
    success: true,
    engineInstalled: isSherpaLibInstalled(),
    models: (Object.keys(TTS_MODELS) as TtsModelId[]).map((id) => {
      const spec = TTS_MODELS[id];
      return {
        id,
        installed: isTtsModelInstalled(id),
        displayName: spec.displayName,
        languages: spec.languages,
        approxInstallBytes: spec.approxInstallBytes,
        sampleRate: spec.sampleRate,
        defaultVoiceId: spec.defaultVoiceId,
        voices: spec.voices,
      };
    }),
  }));

  ipcMain.handle('deleteTtsModel', async (_event, modelId: TtsModelId) => {
    try {
      // TTS worker 独立于 ASR worker：删除前释放自身实例，避免 Windows 文件锁。
      getSherpaTtsRuntime().dispose();
      deleteTtsModel(modelId);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // 「复制下载链接」专用：按引擎域 + 模型 + 当前选中源解析一个可复制的下载/仓库链接。
  // 复用各 catalog 既有的 URL 构造，避免 renderer 重复实现导致与真实下载链接漂移。
  // - funasr（HF 仓库逐文件）/ qwen·firered（modelscope 逐文件）无单一直链 → 复制仓库页地址；
  // - qwen·firered 的 ghproxy/github 源为整包 → 复制 tar.bz2 直链；
  // - pyEngine 为本平台运行时整包 → 复制 release 资产直链。
  ipcMain.handle(
    'resolveModelDownloadUrl',
    async (
      _event,
      {
        scope,
        modelId,
        source,
        variant,
      }: {
        scope: 'funasr' | 'qwen' | 'firered' | 'pyEngine' | 'tts';
        modelId?: string;
        source: string;
        variant?: PyEngineVariant;
      },
    ): Promise<{ success: boolean; url?: string; error?: string }> => {
      try {
        if (scope === 'funasr') {
          const spec = FUNASR_MODELS[modelId as FunasrModelId];
          if (!spec?.repo) return { success: false, error: 'noRepo' };
          return { success: true, url: `${getHfHost(source)}/${spec.repo}` };
        }
        if (scope === 'qwen') {
          const spec = QWEN_MODELS[modelId as QwenModelId];
          if (!spec) return { success: false, error: 'unknownModel' };
          if (source === 'modelscope') {
            return {
              success: true,
              url: `${getModelScopeBase()}/models/${spec.modelScopeRepo}`,
            };
          }
          return {
            success: true,
            url: getQwenArchiveUrl(
              spec,
              source === 'github' ? 'github' : 'ghproxy',
            ),
          };
        }
        if (scope === 'firered') {
          const spec = FIRERED_MODELS[modelId as FireRedModelId];
          if (!spec) return { success: false, error: 'unknownModel' };
          if (source === 'modelscope') {
            return {
              success: true,
              url: `${getModelScopeBase()}/models/${spec.modelScopeRepo}`,
            };
          }
          return {
            success: true,
            url: getFireRedArchiveUrl(
              spec,
              source === 'github' ? 'github' : 'ghproxy',
            ),
          };
        }
        if (scope === 'pyEngine') {
          const s =
            source === 'github' || source === 'gitcode' ? source : 'ghproxy';
          return {
            success: true,
            url: getEngineDownloadUrl(
              s,
              'faster-whisper',
              normalizePyEngineVariant(variant),
            ),
          };
        }
        if (scope === 'tts') {
          const spec = TTS_MODELS[modelId as TtsModelId];
          if (!spec) return { success: false, error: 'unknownModel' };
          return {
            success: true,
            url: getTtsArchiveUrl(
              spec,
              source === 'github' ? 'github' : 'ghproxy',
            ),
          };
        }
        return { success: false, error: 'unknownScope' };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle('cancelModelDownload', async () => {
    modelDownloader.cancel();
    ct2ModelDownloader.cancel();
    funasrModelDownloader.cancel();
    qwenModelDownloader.cancel();
    fireRedModelDownloader.cancel();
    ttsModelDownloader.cancel();
    downloadingModels.clear();
    return true;
  });

  ipcMain.handle(
    'importModel',
    async (
      _event,
      options?: {
        engine?: 'builtin' | FolderImportEngine;
        modelId?: string;
      },
    ) => {
      const engine = options?.engine;

      // builtin（默认/无参）：维持单文件导入（.bin / .mlmodelc → builtin 模型目录）
      if (!engine || engine === 'builtin') {
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
      }

      // 其它引擎：从本地文件夹按指定模型槽导入
      const plan = resolveImportPlan(engine, options?.modelId);
      if (!plan) {
        return { success: false, reason: 'invalid-model' };
      }

      const picked = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      const srcDir = picked.filePaths[0];

      // 导入前校验布局：缺关键文件直接拒绝，不写盘
      const pre = validateModelLayout(srcDir, plan.requiredFiles);
      if (!pre.ok) {
        return {
          success: false,
          reason: 'invalid-layout',
          missing: pre.missing,
        };
      }

      try {
        // 覆盖模型目录前先释放对应 worker，避免 Windows 文件锁
        // （worker 会在下次使用时自动重建）。fasterWhisper 不走 sherpa worker。
        if (engine === 'tts') {
          getSherpaTtsRuntime().dispose();
        } else if (engine !== 'fasterWhisper') {
          getSherpaAsrRuntime().dispose();
        }
        await fse.ensureDir(plan.destDir);
        await fse.copy(srcDir, plan.destDir, { overwrite: true });
      } catch (error) {
        logMessage(`import model error: ${error}`, 'error');
        return { success: false, error: String(error) };
      }

      // 导入后复校验：拷贝后目的地必须齐备
      const post = validateModelLayout(plan.destDir, plan.requiredFiles);
      if (!post.ok) {
        return {
          success: false,
          reason: 'invalid-layout',
          missing: post.missing,
        };
      }
      return { success: true };
    },
  );

  ipcMain.handle(
    'openModelsFolder',
    async (
      _event,
      options?: {
        pathType?: 'ggml' | 'ct2' | 'funasr' | 'qwen' | 'firered' | 'tts';
      },
    ) => {
      const modelsPath =
        options?.pathType === 'ct2'
          ? getFasterWhisperModelsPath()
          : options?.pathType === 'funasr'
            ? getFunasrModelsRoot()
            : options?.pathType === 'qwen'
              ? getQwenModelsRoot()
              : options?.pathType === 'firered'
                ? getFireRedModelsRoot()
                : options?.pathType === 'tts'
                  ? getTtsModelsRoot()
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

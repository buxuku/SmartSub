import { ipcMain, BrowserWindow, dialog } from 'electron';
import { invalidEngineSettings } from '../../types/engineSettings';
import fs from 'fs';
import { logMessage, store } from './storeManager';
import { listEngineAdapters } from './engines/registry';
import { getPyEngineDownloader } from './pythonRuntime/downloader';
import { isTranscriptionBusy } from './taskProcessor';
import {
  getPythonRuntimeManager,
  shutdownPythonRuntime,
} from './pythonRuntime';
import { getEngineDir, getParkedEngineDir } from './pythonRuntime/paths';
import type { TranscriptionEngine } from '../../types/engine';
import type {
  PyEngineDownloadSource,
  PyEngineId,
  PyEngineVariant,
} from '../../types/engine';
import { normalizePyEngineVariant } from './pythonRuntime/paths';

let mainWindow: BrowserWindow | null = null;

/** 仅 faster-whisper 走 Python 运行时下载（其它本地 ASR 使用内置 sherpa 原生库）。 */
function coerceEngineId(_value: unknown): PyEngineId {
  return 'faster-whisper';
}

export function setMainWindowForEngine(window: BrowserWindow): void {
  mainWindow = window;
  // 预绑定运行时下载器的 mainWindow，保证后台（自动更新）触发的下载进度也能上报。
  getPyEngineDownloader('faster-whisper', window);
}

export function registerEngineIpcHandlers(): void {
  ipcMain.handle('get-engine-status', async () => {
    try {
      const adapters = listEngineAdapters();
      const statuses: Record<
        TranscriptionEngine,
        Awaited<ReturnType<(typeof adapters)[number]['isAvailable']>>
      > = {} as Record<
        TranscriptionEngine,
        Awaited<ReturnType<(typeof adapters)[number]['isAvailable']>>
      >;
      for (const adapter of adapters) {
        statuses[adapter.id] = await adapter.isAvailable();
      }
      return statuses;
    } catch (error) {
      logMessage(`Error getting engine status: ${error}`, 'error');
      throw error;
    }
  });

  // --- sherpa-onnx 原生运行库（所有本地 sherpa ASR 引擎共用）：随安装包内置 ---
  // 库随 App 固定发布、整体随版本升级，故无下载/升级/卸载通道，仅暴露内置状态。
  ipcMain.handle('sherpa-lib-status', async () => {
    const { getSherpaLibStatus } = await import(
      './sherpaOnnx/sherpaLibManager'
    );
    return getSherpaLibStatus();
  });

  ipcMain.handle(
    'start-py-engine-download',
    async (
      _event,
      {
        source,
        engineId,
        variant,
      }: {
        source: PyEngineDownloadSource;
        engineId?: PyEngineId;
        variant?: PyEngineVariant;
      },
    ) => {
      try {
        // 运行中禁止安装/升级：避免替换 current/ 时的 Windows 文件锁与转写中断。
        if (isTranscriptionBusy()) {
          return { success: false, error: 'engine_busy' };
        }
        const downloader = getPyEngineDownloader(
          coerceEngineId(engineId),
          mainWindow || undefined,
        );
        if (downloader.isBusy()) {
          return { success: false, error: 'operation_in_progress' };
        }
        // 不支持 cuda 的平台（macOS）会被 normalize 收敛为 cpu，避免下载不存在的产物。
        downloader
          .download(source, normalizePyEngineVariant(variant))
          .catch((error) => {
            logMessage(`Py-engine download failed: ${error}`, 'error');
          });
        return { success: true, started: true };
      } catch (error) {
        logMessage(`Error starting py-engine download: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'check-py-engine-update',
    async (
      _event,
      {
        source,
        engineId,
        variant,
      }: {
        source: PyEngineDownloadSource;
        engineId?: PyEngineId;
        variant?: PyEngineVariant;
      },
    ) => {
      try {
        const info = await getPyEngineDownloader(
          coerceEngineId(engineId),
          mainWindow || undefined,
        ).checkUpdate(
          source,
          variant ? normalizePyEngineVariant(variant) : undefined,
        );
        return { success: true, info };
      } catch (error) {
        logMessage(`Error checking py-engine update: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'cancel-py-engine-download',
    async (_event, payload?: { engineId?: PyEngineId }) => {
      try {
        getPyEngineDownloader(
          coerceEngineId(payload?.engineId),
          mainWindow || undefined,
        ).cancel();
        return { success: true };
      } catch (error) {
        logMessage(`Error cancelling py-engine download: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'get-py-engine-download-progress',
    async (_event, payload?: { engineId?: PyEngineId }) => {
      try {
        return getPyEngineDownloader(
          coerceEngineId(payload?.engineId),
          mainWindow || undefined,
        ).getProgress();
      } catch (error) {
        logMessage(
          `Error getting py-engine download progress: ${error}`,
          'error',
        );
        return null;
      }
    },
  );

  ipcMain.handle(
    'uninstall-py-engine',
    async (_event, payload?: { engineId?: PyEngineId }) => {
      try {
        if (isTranscriptionBusy()) {
          return { success: false, error: 'engine_busy' };
        }
        const engineId = coerceEngineId(payload?.engineId);
        const downloader = getPyEngineDownloader(
          engineId,
          mainWindow || undefined,
        );
        if (downloader.isBusy()) {
          return { success: false, error: 'operation_in_progress' };
        }
        await shutdownPythonRuntime();

        // 整个引擎包目录（含内部 manifest.json）一并删除即回到未安装态；
        // 变体切换驻留的副本一并清理，避免卸载后残留大体积目录。
        const engineDir = getEngineDir(engineId);
        if (fs.existsSync(engineDir)) {
          fs.rmSync(engineDir, { recursive: true, force: true });
        }
        for (const variant of ['cpu', 'cuda'] as PyEngineVariant[]) {
          const parkedDir = getParkedEngineDir(engineId, variant);
          if (fs.existsSync(parkedDir)) {
            fs.rmSync(parkedDir, { recursive: true, force: true });
          }
        }

        return { success: true };
      } catch (error) {
        logMessage(`Error uninstalling py-engine: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'import-py-engine',
    async (
      _event,
      payload?: {
        engineId?: PyEngineId;
        sourcePath?: string;
      },
    ) => {
      try {
        if (isTranscriptionBusy()) {
          return { success: false, error: 'engine_busy' };
        }
        const engineId = coerceEngineId(payload?.engineId);
        const downloader = getPyEngineDownloader(
          engineId,
          mainWindow || undefined,
        );
        if (downloader.isBusy()) {
          return { success: false, error: 'operation_in_progress' };
        }

        let sourcePath = payload?.sourcePath;
        if (!sourcePath) {
          const properties: Array<'openFile' | 'openDirectory'> =
            process.platform === 'darwin'
              ? ['openFile', 'openDirectory']
              : ['openFile'];
          const picked = await dialog.showOpenDialog(mainWindow ?? undefined, {
            title: '选择 faster-whisper 运行时压缩包或目录',
            properties,
            filters: [
              {
                name: 'Runtime Package',
                extensions: ['tar.gz', 'tgz', 'gz', 'tar', 'zip'],
              },
              { name: 'All Files', extensions: ['*'] },
            ],
          });
          if (picked.canceled || picked.filePaths.length === 0) {
            return { success: false, canceled: true };
          }
          sourcePath = picked.filePaths[0];
        }

        return await downloader.importRuntime(sourcePath);
      } catch (error) {
        logMessage(`Error importing py-engine: ${error}`, 'error');
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    'set-faster-whisper-settings',
    async (
      _event,
      {
        device,
        computeType,
      }: {
        device?: 'auto' | 'cpu' | 'cuda';
        computeType?: string;
      },
    ) => {
      try {
        const patch = {
          ...(device !== undefined ? { fasterWhisperDevice: device } : {}),
          ...(computeType !== undefined
            ? { fasterWhisperComputeType: computeType }
            : {}),
        };
        if (invalidEngineSettings(patch).length)
          return { success: false, error: 'INVALID_ENGINE_SETTINGS' };
        const settings = store.get('settings');
        store.set('settings', {
          ...settings,
          ...patch,
        });
        return { success: true };
      } catch (error) {
        logMessage(`Error setting faster-whisper settings: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'set-funasr-settings',
    async (
      _event,
      {
        provider,
        useItn,
        numThreads,
      }: {
        provider?: 'cpu' | 'cuda' | 'coreml';
        useItn?: boolean;
        numThreads?: number;
      },
    ) => {
      try {
        const settings = store.get('settings');
        store.set('settings', {
          ...settings,
          ...(provider !== undefined ? { funasrProvider: provider } : {}),
          ...(useItn !== undefined ? { funasrUseItn: useItn } : {}),
          ...(numThreads !== undefined ? { funasrNumThreads: numThreads } : {}),
        });
        return { success: true };
      } catch (error) {
        logMessage(`Error setting funasr settings: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'set-qwen-settings',
    async (
      _event,
      {
        provider,
        numThreads,
      }: {
        provider?: 'cpu' | 'cuda';
        numThreads?: number;
      },
    ) => {
      try {
        const settings = store.get('settings');
        store.set('settings', {
          ...settings,
          ...(provider !== undefined ? { qwenProvider: provider } : {}),
          ...(numThreads !== undefined ? { qwenNumThreads: numThreads } : {}),
        });
        return { success: true };
      } catch (error) {
        logMessage(`Error setting qwen settings: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'set-firered-settings',
    async (
      _event,
      {
        provider,
        numThreads,
      }: {
        provider?: 'cpu' | 'cuda';
        numThreads?: number;
      },
    ) => {
      try {
        const settings = store.get('settings');
        store.set('settings', {
          ...settings,
          ...(provider !== undefined ? { fireRedProvider: provider } : {}),
          ...(numThreads !== undefined
            ? { fireRedNumThreads: numThreads }
            : {}),
        });
        return { success: true };
      } catch (error) {
        logMessage(`Error setting firered settings: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'set-parakeet-settings',
    async (
      _event,
      {
        provider,
        numThreads,
      }: {
        provider?: 'cpu' | 'cuda';
        numThreads?: number;
      },
    ) => {
      try {
        const settings = store.get('settings');
        store.set('settings', {
          ...settings,
          ...(provider !== undefined ? { parakeetProvider: provider } : {}),
          ...(numThreads !== undefined
            ? { parakeetNumThreads: numThreads }
            : {}),
        });
        return { success: true };
      } catch (error) {
        logMessage(`Error setting parakeet settings: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'python-engine:ping',
    async (_event, payload?: { engineId?: PyEngineId }) => {
      try {
        const manager = getPythonRuntimeManager();
        // 唯一的 Python 引擎是 faster-whisper（coerceEngineId 恒返回它），按显式 engineId 预热。
        const engineId = coerceEngineId(payload?.engineId);
        await manager.ensureStarted(engineId);
        return { success: true };
      } catch (error) {
        logMessage(`Python engine ping failed: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  logMessage('Engine IPC handlers registered', 'info');
}

import { ipcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import { logMessage, store } from './storeManager';
import { listEngineAdapters } from './engines/registry';
import { getPyEngineDownloader } from './pythonRuntime/downloader';
import { getPyBaseDownloader } from './pythonRuntime/baseDownloader';
import { isTranscriptionBusy } from './taskProcessor';
import {
  getPythonRuntimeManager,
  shutdownPythonRuntime,
} from './pythonRuntime';
import {
  getEngineDir,
  getPyBaseSource,
  isPyBaseReady,
} from './pythonRuntime/paths';
import type { TranscriptionEngine } from '../../types/engine';
import type {
  PyEngineDownloadSource,
  PyEngineId,
  PyBaseStatus,
} from '../../types/engine';

let mainWindow: BrowserWindow | null = null;

/** 仅 faster-whisper 走 Python 三层架构下载（funasr 已迁移 sherpa 原生库）。 */
function coerceEngineId(_value: unknown): PyEngineId {
  return 'faster-whisper';
}

export function setMainWindowForEngine(window: BrowserWindow): void {
  mainWindow = window;
  // 预绑定引擎下载器的 mainWindow，保证后台（自动更新）触发的下载进度也能上报。
  getPyEngineDownloader('faster-whisper', window);
  // Layer 1 基座下载器同样预绑定，使后台升级进度可上报。
  getPyBaseDownloader(window);
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
      return {};
    }
  });

  // --- sherpa-onnx 原生运行库（funasr 引擎用）：按需下载到 userData ---
  ipcMain.handle('sherpa-lib-status', async () => {
    const { getSherpaLibStatus } = await import(
      './sherpaOnnx/sherpaLibManager'
    );
    return getSherpaLibStatus();
  });

  // funasr 运行库版本随 App 固定发布：已装版本 ≠ App 预期版本即视为可升级（重下覆盖）。
  ipcMain.handle('check-sherpa-lib-update', async () => {
    try {
      const { getSherpaLibStatus } = await import(
        './sherpaOnnx/sherpaLibManager'
      );
      const { SHERPA_VERSION } = await import(
        './sherpaOnnx/sherpaLibDownloader'
      );
      const status = getSherpaLibStatus();
      const installed = status.installed ? status.version : undefined;
      const hasUpdate = !!installed && installed !== SHERPA_VERSION;
      return { success: true, installed, latest: SHERPA_VERSION, hasUpdate };
    } catch (error) {
      logMessage(`Error checking sherpa lib update: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle(
    'download-sherpa-lib',
    async (_e, { source }: { source?: string }) => {
      try {
        if (isTranscriptionBusy()) {
          return { success: false, error: 'engine_busy' };
        }
        const { downloadSherpaLib } = await import(
          './sherpaOnnx/sherpaLibDownloader'
        );
        await downloadSherpaLib(source || 'gitcode', (percent) =>
          mainWindow?.webContents.send('sherpa-lib-download-progress', {
            progress: percent,
          }),
        );
        return { success: true };
      } catch (error) {
        logMessage(`sherpa lib download failed: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle('remove-sherpa-lib', async () => {
    try {
      if (isTranscriptionBusy()) {
        return { success: false, error: 'engine_busy' };
      }
      const { removeSherpaLib } = await import('./sherpaOnnx/sherpaLibManager');
      removeSherpaLib();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle(
    'start-py-engine-download',
    async (
      _event,
      {
        source,
        engineId,
      }: { source: PyEngineDownloadSource; engineId?: PyEngineId },
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
        downloader.download(source).catch((error) => {
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
      }: { source: PyEngineDownloadSource; engineId?: PyEngineId },
    ) => {
      try {
        const info = await getPyEngineDownloader(
          coerceEngineId(engineId),
          mainWindow || undefined,
        ).checkUpdate(source);
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
        await shutdownPythonRuntime();

        // 整个引擎包目录（含内部 manifest.json）一并删除即回到未安装态
        const engineDir = getEngineDir(coerceEngineId(payload?.engineId));
        if (fs.existsSync(engineDir)) {
          fs.rmSync(engineDir, { recursive: true, force: true });
        }

        return { success: true };
      } catch (error) {
        logMessage(`Error uninstalling py-engine: ${error}`, 'error');
        return { success: false, error: String(error) };
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
        const settings = store.get('settings');
        store.set('settings', {
          ...settings,
          ...(device !== undefined ? { fasterWhisperDevice: device } : {}),
          ...(computeType !== undefined
            ? { fasterWhisperComputeType: computeType }
            : {}),
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

  // ── Layer 1：Python 基座（内置为主 + 可在线升级覆盖）────────────────────────
  ipcMain.handle('get-py-base-status', async (): Promise<PyBaseStatus> => {
    return {
      state: isPyBaseReady() ? 'ready' : 'not_installed',
      source: getPyBaseSource(),
    };
  });

  ipcMain.handle(
    'start-py-base-download',
    async (_event, { source }: { source: PyEngineDownloadSource }) => {
      try {
        // 运行中禁止替换基座：避免停机/换目录打断转写与 Windows 文件锁。
        if (isTranscriptionBusy()) {
          return { success: false, error: 'engine_busy' };
        }
        getPyBaseDownloader(mainWindow || undefined)
          .download(source)
          .catch((e) => logMessage(`Py-base download failed: ${e}`, 'error'));
        return { success: true, started: true };
      } catch (error) {
        logMessage(`Error starting py-base download: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle(
    'check-py-base-update',
    async (_event, { source }: { source: PyEngineDownloadSource }) => {
      try {
        const info = await getPyBaseDownloader(
          mainWindow || undefined,
        ).checkUpdate(source);
        return { success: true, info };
      } catch (error) {
        logMessage(`Error checking py-base update: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  ipcMain.handle('cancel-py-base-download', async () => {
    try {
      getPyBaseDownloader(mainWindow || undefined).cancel();
      return { success: true };
    } catch (error) {
      logMessage(`Error cancelling py-base download: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('get-py-base-download-progress', async () => {
    try {
      return getPyBaseDownloader(mainWindow || undefined).getProgress();
    } catch (error) {
      logMessage(`Error getting py-base download progress: ${error}`, 'error');
      return null;
    }
  });

  logMessage('Engine IPC handlers registered', 'info');
}

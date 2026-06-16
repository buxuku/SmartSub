import { ipcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import { logMessage, store } from './storeManager';
import { resolveTranscriptionEngine } from './transcriptionEngine';
import { listEngineAdapters } from './engines/registry';
import { getPyEngineDownloader } from './pythonRuntime/downloader';
import { isTranscriptionBusy } from './taskProcessor';
import {
  getPythonRuntimeManager,
  shutdownPythonRuntime,
} from './pythonRuntime';
import { getEngineDir, isEnginePackageInstalled } from './pythonRuntime/paths';
import type { TranscriptionEngine } from '../../types/engine';
import type { PyEngineDownloadSource, PyEngineId } from '../../types/engine';

let mainWindow: BrowserWindow | null = null;

/** 仅这两个引擎走 Python 三层架构下载；payload 缺省时回退 faster-whisper（向后兼容旧渲染层）。 */
function coerceEngineId(value: unknown): PyEngineId {
  return value === 'funasr' ? 'funasr' : 'faster-whisper';
}

export function setMainWindowForEngine(window: BrowserWindow): void {
  mainWindow = window;
}

export function registerEngineIpcHandlers(): void {
  ipcMain.handle('get-transcription-engine', async () => {
    try {
      return resolveTranscriptionEngine(store.get('settings'));
    } catch (error) {
      logMessage(`Error getting transcription engine: ${error}`, 'error');
      return 'builtin' as const;
    }
  });

  ipcMain.handle(
    'set-transcription-engine',
    async (_event, engine: TranscriptionEngine) => {
      try {
        if (
          engine === 'fasterWhisper' &&
          !isEnginePackageInstalled('faster-whisper')
        ) {
          return { success: false, error: 'engine_not_installed' };
        }
        const settings = store.get('settings');
        store.set('settings', {
          ...settings,
          transcriptionEngine: engine,
          useLocalWhisper: engine === 'localCli',
        });
        // 切到 faster-whisper 后预热 sidecar，把冷启动成本移出首个文件关键路径。
        if (engine === 'fasterWhisper') {
          void getPythonRuntimeManager()
            .ensureStarted('faster-whisper')
            .catch((e) =>
              logMessage(`engine warmup failed (non-fatal): ${e}`, 'warning'),
            );
        }
        return { success: true };
      } catch (error) {
        logMessage(`Error setting transcription engine: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

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
    'python-engine:ping',
    async (_event, payload?: { engineId?: PyEngineId }) => {
      try {
        const manager = getPythonRuntimeManager();
        await manager.ensureStarted(coerceEngineId(payload?.engineId));
        return { success: true };
      } catch (error) {
        logMessage(`Python engine ping failed: ${error}`, 'error');
        return { success: false, error: String(error) };
      }
    },
  );

  logMessage('Engine IPC handlers registered', 'info');
}

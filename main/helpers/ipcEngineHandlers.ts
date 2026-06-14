import { ipcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { logMessage, store } from './storeManager';
import { resolveTranscriptionEngine } from './transcriptionEngine';
import { listEngineAdapters } from './engines/registry';
import { getPyEngineDownloader } from './pythonRuntime/downloader';
import {
  getPythonRuntimeManager,
  shutdownPythonRuntime,
} from './pythonRuntime';
import {
  getPyEngineCurrentDir,
  getPyEngineRoot,
  isPyEngineInstalled,
} from './pythonRuntime/paths';
import type { TranscriptionEngine } from '../../types/engine';
import type { PyEngineDownloadSource } from '../../types/engine';

let mainWindow: BrowserWindow | null = null;

export function setMainWindowForEngine(window: BrowserWindow): void {
  mainWindow = window;
  getPyEngineDownloader(window);
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
        if (engine === 'fasterWhisper' && !isPyEngineInstalled()) {
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
            .ensureStarted()
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
    async (_event, { source }: { source: PyEngineDownloadSource }) => {
      try {
        const downloader = getPyEngineDownloader(mainWindow || undefined);
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

  ipcMain.handle('cancel-py-engine-download', async () => {
    try {
      getPyEngineDownloader().cancel();
      return { success: true };
    } catch (error) {
      logMessage(`Error cancelling py-engine download: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('get-py-engine-download-progress', async () => {
    try {
      return getPyEngineDownloader().getProgress();
    } catch (error) {
      logMessage(
        `Error getting py-engine download progress: ${error}`,
        'error',
      );
      return null;
    }
  });

  ipcMain.handle('uninstall-py-engine', async () => {
    try {
      await shutdownPythonRuntime();

      const currentDir = getPyEngineCurrentDir();
      if (fs.existsSync(currentDir)) {
        fs.rmSync(currentDir, { recursive: true, force: true });
      }

      const manifestPath = path.join(getPyEngineRoot(), 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
      }

      return { success: true };
    } catch (error) {
      logMessage(`Error uninstalling py-engine: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

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

  ipcMain.handle('python-engine:ping', async () => {
    try {
      const manager = getPythonRuntimeManager();
      await manager.ensureStarted();
      return { success: true };
    } catch (error) {
      logMessage(`Python engine ping failed: ${error}`, 'error');
      return { success: false, error: String(error) };
    }
  });

  logMessage('Engine IPC handlers registered', 'info');
}

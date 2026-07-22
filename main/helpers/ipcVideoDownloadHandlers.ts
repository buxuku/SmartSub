import { ipcMain, shell, dialog, BrowserWindow } from 'electron';
import { logMessage } from './storeManager';
import {
  cancelDownloaderInstall,
  fetchDownloaderManifest,
  getDownloaderBinaryPath,
  getDownloaderStatuses,
  getInstalledEngines,
  installDownloader,
} from './downloaderManager';
import {
  cancelDownloadBatch,
  cancelDownloadEntry,
  isVideoDownloadBusy,
  resumeDownloadBatch,
  retryDownloadEntry,
  setVideoDownloadEmitter,
  startDownloadBatch,
  type StartDownloadPayload,
} from './videoDownload/scheduler';
import { ytDlpAdapter } from './videoDownload/ytDlpAdapter';
import { luxAdapter } from './videoDownload/luxAdapter';
import { withCookieFile } from './videoDownload/engineAdapter';
import {
  deleteCookieProfile,
  listCookieProfiles,
} from './videoDownload/cookieProfileStore';
import {
  importCookiesFromBrowser,
  importCookiesFromFile,
  importCookiesFromPaste,
  type SupportedBrowser,
} from './videoDownload/cookieImport';
import { routeEngines } from '../../types/download';
import type {
  DownloadEngineChoice,
  DownloadPreflightResult,
  DownloaderEngine,
} from '../../types/download';
import type { BinaryDownloadSource } from './downloadSourceOrder';

const PREFLIGHT_CONCURRENCY = 3;

const ADAPTERS = { 'yt-dlp': ytDlpAdapter, lux: luxAdapter } as const;

async function preflightOne(
  url: string,
  engineChoice: DownloadEngineChoice,
): Promise<DownloadPreflightResult> {
  const installed = getInstalledEngines();
  const order = routeEngines(url, engineChoice, installed);
  if (order.length === 0) {
    return {
      url,
      ok: false,
      engine: engineChoice === 'lux' ? 'lux' : 'yt-dlp',
      error: 'No downloader engine installed',
    };
  }
  // cookie 临时副本按 url 匹配档案生成，供本 url 的所有引擎预检尝试共用
  return withCookieFile(url, async (cookieFilePath) => {
    const errors: string[] = [];
    for (const engine of order) {
      const binaryPath = getDownloaderBinaryPath(engine);
      if (!binaryPath) continue;
      try {
        const meta = await ADAPTERS[engine].preflight(binaryPath, {
          url,
          cookieFilePath,
        });
        return { url, ok: true, engine, meta };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${engine}: ${message}`);
      }
    }
    return {
      url,
      ok: false,
      engine: order[0],
      error: errors.join(' || ') || 'preflight failed',
    };
  });
}

/** 有限并发跑完全部预检（单条失败不阻断其余） */
async function runPreflight(
  urls: string[],
  engineChoice: DownloadEngineChoice,
): Promise<DownloadPreflightResult[]> {
  const results: DownloadPreflightResult[] = new Array(urls.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(PREFLIGHT_CONCURRENCY, urls.length) },
    async () => {
      while (cursor < urls.length) {
        const index = cursor++;
        results[index] = await preflightOne(urls[index], engineChoice);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function setupVideoDownloadHandlers(mainWindow: BrowserWindow): void {
  setVideoDownloadEmitter((channel, ...args) => {
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, ...args);
      }
    } catch (error) {
      logMessage(`videoDownload emit failed: ${error}`, 'warning');
    }
  });

  const sendInstallProgress = (payload: unknown) => {
    try {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('videoDownload:installProgress', payload);
      }
    } catch {
      // 窗口销毁时静默
    }
  };

  // ── 下载器二进制管理 ──────────────────────────────────────────────

  ipcMain.handle(
    'videoDownload:getStatuses',
    async (
      _event,
      payload?: { source?: BinaryDownloadSource; fetchRemote?: boolean },
    ) => {
      try {
        return await getDownloaderStatuses(
          payload?.source || 'github',
          payload?.fetchRemote !== false,
        );
      } catch (error) {
        logMessage(`videoDownload:getStatuses failed: ${error}`, 'error');
        return [];
      }
    },
  );

  ipcMain.handle(
    'videoDownload:checkUpdates',
    async (_event, payload?: { source?: BinaryDownloadSource }) => {
      const source = payload?.source || 'github';
      await fetchDownloaderManifest(source, true);
      return getDownloaderStatuses(source, false);
    },
  );

  ipcMain.handle(
    'videoDownload:install',
    async (
      _event,
      payload: { engine: DownloaderEngine; source?: BinaryDownloadSource },
    ) => {
      const { engine } = payload;
      // 更新会原子替换二进制；执行中的下载持有旧路径句柄，等它跑完再换
      if (isVideoDownloadBusy() && getDownloaderBinaryPath(engine)) {
        throw new Error('BUSY_DOWNLOADING');
      }
      const info = await installDownloader(
        engine,
        payload.source || 'github',
        sendInstallProgress,
      );
      return info;
    },
  );

  ipcMain.handle(
    'videoDownload:cancelInstall',
    (_event, payload: { engine: DownloaderEngine }) => {
      cancelDownloaderInstall(payload.engine);
      return true;
    },
  );

  // ── 预检与下载 ────────────────────────────────────────────────────

  ipcMain.handle(
    'videoDownload:preflight',
    async (
      _event,
      payload: { urls: string[]; engine?: DownloadEngineChoice },
    ) => {
      const urls = (payload?.urls || []).filter(Boolean);
      if (urls.length === 0) return [];
      return runPreflight(urls, payload?.engine || 'auto');
    },
  );

  ipcMain.handle(
    'videoDownload:start',
    (_event, payload: StartDownloadPayload) => {
      const item = startDownloadBatch(payload);
      return item;
    },
  );

  ipcMain.handle(
    'videoDownload:resume',
    (_event, payload: { workItemId: string }) =>
      resumeDownloadBatch(payload.workItemId),
  );

  ipcMain.handle(
    'videoDownload:retryEntry',
    async (
      _event,
      payload: {
        workItemId: string;
        entryId: string;
        /** 先更新引擎再重试（失败项的「更新下载器后重试」快捷动作） */
        updateFirst?: boolean;
        source?: BinaryDownloadSource;
      },
    ) => {
      if (payload.updateFirst) {
        const source = payload.source || 'github';
        await fetchDownloaderManifest(source, true);
        const statuses = await getDownloaderStatuses(source, false);
        for (const status of statuses) {
          if (status.installed && status.hasUpdate) {
            try {
              await installDownloader(
                status.engine,
                source,
                sendInstallProgress,
              );
            } catch (error) {
              logMessage(
                `update ${status.engine} before retry failed: ${error}`,
                'warning',
              );
            }
          }
        }
      }
      return retryDownloadEntry(payload.workItemId, payload.entryId);
    },
  );

  ipcMain.handle(
    'videoDownload:cancelEntry',
    (_event, payload: { workItemId: string; entryId: string }) =>
      cancelDownloadEntry(payload.workItemId, payload.entryId),
  );

  ipcMain.handle(
    'videoDownload:cancelBatch',
    (_event, payload: { workItemId: string }) =>
      cancelDownloadBatch(payload.workItemId),
  );

  ipcMain.handle(
    'videoDownload:revealFile',
    (_event, payload: { filePath: string }) => {
      shell.showItemInFolder(payload.filePath);
      return true;
    },
  );

  // ── 站点 Cookie 档案 ──────────────────────────────────────────────

  interface CustomDefPayload {
    name: string;
    matchDomains: string[];
    cookieDomains: string[];
  }

  ipcMain.handle('videoDownload:cookieProfiles:list', () => {
    try {
      return listCookieProfiles();
    } catch (error) {
      logMessage(`cookieProfiles:list failed: ${error}`, 'error');
      return [];
    }
  });

  ipcMain.handle(
    'videoDownload:cookieProfiles:importFile',
    async (_event, payload: { id: string; customDef?: CustomDefPayload }) => {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Select cookies.txt',
        properties: ['openFile'],
        filters: [
          { name: 'Cookies', extensions: ['txt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (picked.canceled || !picked.filePaths[0]) {
        return { cancelled: true };
      }
      const result = importCookiesFromFile({
        id: payload.id,
        filePath: picked.filePaths[0],
        customDef: payload.customDef,
      });
      return { cancelled: false, ...result };
    },
  );

  ipcMain.handle(
    'videoDownload:cookieProfiles:importPaste',
    (
      _event,
      payload: { id: string; raw: string; customDef?: CustomDefPayload },
    ) =>
      importCookiesFromPaste({
        id: payload.id,
        raw: payload.raw,
        customDef: payload.customDef,
      }),
  );

  ipcMain.handle(
    'videoDownload:cookieProfiles:importFromBrowser',
    (
      _event,
      payload: {
        id: string;
        browser: SupportedBrowser;
        customDef?: CustomDefPayload;
      },
    ) =>
      importCookiesFromBrowser({
        id: payload.id,
        browser: payload.browser,
        customDef: payload.customDef,
      }),
  );

  ipcMain.handle(
    'videoDownload:cookieProfiles:delete',
    (_event, payload: { id: string }) => deleteCookieProfile(payload.id),
  );
}

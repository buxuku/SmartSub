import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logMessage } from '../storeManager';
import { getPyEngineDownloader } from './downloader';
import { isEnginePackageInstalled } from './paths';
import type { PyEngineDownloadSource, PyEngineId } from '../../../types/engine';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 走 Python 三层架构、支持在线下载/更新的引擎集合。 */
const UPDATABLE_ENGINES: PyEngineId[] = ['faster-whisper', 'funasr'];

function getStatePath(): string {
  return path.join(app.getPath('userData'), 'py-engine-update-check.json');
}

function readLastCheckAt(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
    return typeof parsed?.lastCheckAt === 'number' ? parsed.lastCheckAt : 0;
  } catch {
    return 0;
  }
}

function writeLastCheckAt(ts: number): void {
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify({ lastCheckAt: ts }));
  } catch (error) {
    logMessage(
      `py-engine update-check state write failed: ${error}`,
      'warning',
    );
  }
}

/**
 * 启动后每日一次的节流静默更新检查：遍历所有已安装的 Python 引擎，发现更新时通过
 * `py-engine-update-available` 通知渲染层（携带 engineId，不自动下载）。弱网/失败静默，仅日志。
 */
export async function maybeAutoCheckPyEngineUpdate(
  mainWindow: BrowserWindow,
  source: PyEngineDownloadSource = 'github',
): Promise<void> {
  const installedEngines = UPDATABLE_ENGINES.filter((engineId) =>
    isEnginePackageInstalled(engineId),
  );
  if (installedEngines.length === 0) return;

  const now = Date.now();
  if (now - readLastCheckAt() < CHECK_INTERVAL_MS) return;

  let anyChecked = false;
  for (const engineId of installedEngines) {
    try {
      const info = await getPyEngineDownloader(
        engineId,
        mainWindow,
      ).checkUpdate(source);
      anyChecked = true;
      if (info.hasUpdate && info.protocolSupported) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('py-engine-update-available', {
            ...info,
            engineId,
          });
        }
        logMessage(
          `py-engine[${engineId}] update available (daily auto-check)`,
          'info',
        );
      }
    } catch (error) {
      // 单引擎失败不影响其它引擎；本轮不写 lastCheckAt，下次启动可重试
      logMessage(
        `py-engine[${engineId}] daily update-check failed: ${error}`,
        'warning',
      );
    }
  }

  // 仅当至少一个引擎成功检查后才落地节流时间戳
  if (anyChecked) writeLastCheckAt(now);
}

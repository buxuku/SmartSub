import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logMessage } from '../storeManager';
import { getPyEngineDownloader } from './downloader';
import { isEnginePackageInstalled } from './paths';
import type { PyEngineDownloadSource } from '../../../types/engine';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
 * 启动后每日一次的节流静默更新检查：仅在已安装时检查，发现更新时通过
 * `py-engine-update-available` 通知渲染层（不自动下载）。弱网/失败静默，仅日志。
 */
export async function maybeAutoCheckPyEngineUpdate(
  mainWindow: BrowserWindow,
  source: PyEngineDownloadSource = 'github',
): Promise<void> {
  if (!isEnginePackageInstalled('faster-whisper')) return;

  const now = Date.now();
  if (now - readLastCheckAt() < CHECK_INTERVAL_MS) return;

  try {
    const info = await getPyEngineDownloader(mainWindow).checkUpdate(source);
    writeLastCheckAt(now);
    if (info.hasUpdate && info.protocolSupported) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('py-engine-update-available', info);
      }
      logMessage('py-engine update available (daily auto-check)', 'info');
    }
  } catch (error) {
    // 失败不写入 lastCheckAt，下次启动可重试
    logMessage(`py-engine daily update-check failed: ${error}`, 'warning');
  }
}

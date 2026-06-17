import fs from 'fs';
import { logMessage } from '../storeManager';
import {
  getSherpaLibDir,
  getSherpaStagingDir,
  getSherpaPreviousDir,
  isSherpaLibInstalled,
  readSherpaManifest,
} from './sherpaLibPaths';
import type { SherpaLibStatus } from '../../../types/sherpa';

export function getSherpaLibStatus(): SherpaLibStatus {
  const m = readSherpaManifest();
  return {
    installed: isSherpaLibInstalled(),
    version: m?.sherpaVersion,
    platform: m?.platform,
    installedAt: m?.builtAt,
  };
}

/** staging → current 原子替换；旧 current 备份到 previous（便于回滚）。 */
export function promoteStagingToCurrent(): void {
  const current = getSherpaLibDir();
  const staging = getSherpaStagingDir();
  const previous = getSherpaPreviousDir();
  if (!fs.existsSync(staging)) throw new Error('sherpa staging dir missing');
  if (fs.existsSync(previous)) {
    fs.rmSync(previous, { recursive: true, force: true });
  }
  if (fs.existsSync(current)) fs.renameSync(current, previous);
  fs.renameSync(staging, current);
  logMessage('sherpa lib promoted staging->current', 'info');
}

export function rollbackToPrevious(): boolean {
  const current = getSherpaLibDir();
  const previous = getSherpaPreviousDir();
  if (!fs.existsSync(previous)) return false;
  if (fs.existsSync(current)) {
    fs.rmSync(current, { recursive: true, force: true });
  }
  fs.renameSync(previous, current);
  logMessage('sherpa lib rolled back to previous', 'warning');
  return true;
}

export function removeSherpaLib(): void {
  for (const d of [
    getSherpaLibDir(),
    getSherpaStagingDir(),
    getSherpaPreviousDir(),
  ]) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
  logMessage('sherpa lib removed', 'info');
}

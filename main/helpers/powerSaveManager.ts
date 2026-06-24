import { powerSaveBlocker } from 'electron';
import { logMessage } from './logger';
import { store } from './store';

const activeReasons = new Set<string>();
let blockerId: number | null = null;

function shouldPreventSleepDuringTask(): boolean {
  const settings = store.get('settings');
  return settings?.preventSleepDuringTask !== false;
}

function startBlocker() {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    return;
  }

  blockerId = powerSaveBlocker.start('prevent-app-suspension');
  logMessage(`Power save blocker started: ${blockerId}`, 'info');
}

function stopBlocker() {
  if (blockerId === null) {
    return;
  }

  const id = blockerId;
  blockerId = null;

  try {
    if (powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id);
      logMessage(`Power save blocker stopped: ${id}`, 'info');
    }
  } catch (error) {
    logMessage(`Power save blocker stop failed: ${error}`, 'warning');
  }
}

export function syncTaskPowerSaveBlocker() {
  if (activeReasons.size > 0 && shouldPreventSleepDuringTask()) {
    startBlocker();
  } else {
    stopBlocker();
  }
}

export function acquireTaskPowerSaveBlocker(reason: string) {
  activeReasons.add(reason);
  syncTaskPowerSaveBlocker();
}

export function releaseTaskPowerSaveBlocker(reason: string) {
  activeReasons.delete(reason);
  syncTaskPowerSaveBlocker();
}

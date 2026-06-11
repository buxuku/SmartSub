import { app, ipcMain } from 'electron';
import { store } from './store';
import { IFiles } from '../../types';

let taskList: IFiles[] = [];
let writeTimer: NodeJS.Timeout | null = null;

const STAGE_KEYS = [
  'extractAudio',
  'extractSubtitle',
  'translateSubtitle',
  'prepareSubtitle',
] as const;

/** 上次运行中断的任务：loading 阶段改写为 error + 哨兵，renderer 翻译并提供重试 */
function markInterrupted(file: IFiles): IFiles {
  const next: Record<string, any> = { ...file };
  for (const key of STAGE_KEYS) {
    if (next[key] === 'loading') {
      next[key] = 'error';
      next[`${key}Error`] = 'TASK_INTERRUPTED';
    }
  }
  return next as IFiles;
}

/** 进度事件很频繁，落盘做防抖 */
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    store.set('tasks', taskList);
  }, 800);
}

function flushWrite() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  store.set('tasks', taskList);
}

export function setupTaskManager() {
  const stored = store.get('tasks');
  taskList = Array.isArray(stored) ? stored.map(markInterrupted) : [];

  ipcMain.handle('getTasks', () => {
    return taskList;
  });

  ipcMain.on('setTasks', (event, tasks) => {
    taskList = tasks;
    scheduleWrite();
  });

  ipcMain.on('clearTasks', () => {
    taskList = [];
    flushWrite();
  });

  app.on('before-quit', flushWrite);
}

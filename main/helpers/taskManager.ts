import { ipcMain } from 'electron';
import type { ITaskFile } from '../../types';

let taskList: ITaskFile[] = [];

export function setupTaskManager() {
  ipcMain.handle('getTasks', () => {
    return taskList;
  });

  ipcMain.on('setTasks', (event, tasks) => {
    taskList = tasks;
  });

  ipcMain.on('clearTasks', () => {
    taskList = [];
  });
}

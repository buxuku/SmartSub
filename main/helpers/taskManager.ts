import { ipcMain } from 'electron';
import type { IFiles } from '../../types';

let taskList: IFiles[] = [];

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

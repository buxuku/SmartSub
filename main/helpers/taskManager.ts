import { ipcMain } from 'electron';

let taskList = [];

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

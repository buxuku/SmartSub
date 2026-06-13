import { ipcMain } from 'electron';
import {
  deleteWorkItem,
  getWorkItemById,
  getWorkItems,
  renameWorkItem,
  saveWorkItem,
  clearAllWorkItems,
} from './workItemStore';
import type { WorkItem } from '../../types/workItem';

export function setupWorkItemHandlers(): void {
  ipcMain.handle('getWorkItems', () => getWorkItems());

  ipcMain.handle('getWorkItem', (_event, id: string) => getWorkItemById(id));

  ipcMain.handle('saveWorkItem', (_event, item: WorkItem) =>
    saveWorkItem(item),
  );

  ipcMain.handle('deleteWorkItem', (_event, id: string) => deleteWorkItem(id));

  ipcMain.handle(
    'renameWorkItem',
    (_event, payload: { id: string; name: string }) =>
      renameWorkItem(payload?.id, payload?.name || ''),
  );

  ipcMain.handle('clearAllWorkItems', () => {
    clearAllWorkItems();
    return true;
  });
}

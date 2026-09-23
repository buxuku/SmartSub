import { ipcMain } from '../automation/handlers';
import { BrowserWindow } from 'electron';
import {
  deleteWorkItem,
  getWorkItemById,
  getWorkItems,
  renameWorkItem,
  saveWorkItem,
  clearAllWorkItems,
  setWorkItemDeletionHandler,
} from './workItemStore';
import {
  forgetDubbingSession,
  getDubbingSession,
} from './dubbing/dubbingProcessor';
import { stageSessionDeletion } from './dubbing/sessionStore';
import { dubbingSessionOwnership } from './dubbing/sessionOwnership';
import { workItemSessionIds } from './dubbing/workItemSessions';
import { cancelDownloadBatch } from './videoDownload/scheduler';
import type { WorkItem } from '../../types/workItem';
import { isTaskProjectBusy } from './taskProcessor';

export function setupWorkItemHandlers(): void {
  setWorkItemDeletionHandler((items: WorkItem[]) => {
    const deleting = new Set(items.map((item) => item.id));
    const allIds = [...new Set(items.flatMap(workItemSessionIds))];
    if (
      items.some(
        (item) =>
          (item.type === 'compose' || item.type === 'toolbox') &&
          ['waiting', 'running'].includes(item.status),
      ) ||
      items.some(
        (item) => item.type !== 'download' && isTaskProjectBusy(item.id),
      ) ||
      allIds.some(
        (id) =>
          dubbingSessionOwnership.isBusy(id) || getDubbingSession(id)?.running,
      )
    )
      throw new Error(
        'Project is open or running. Close its dubbing editor and stop the task before deleting it.',
      );
    const referenced = new Set(
      getWorkItems()
        .filter((item) => !deleting.has(item.id))
        .flatMap(workItemSessionIds),
    );
    const ids = allIds.filter((id) => !referenced.has(id));
    const staged = stageSessionDeletion(ids);
    return {
      rollback: staged.rollback,
      commit: () => {
        ids.forEach(forgetDubbingSession);
        staged.commit();
        for (const window of BrowserWindow.getAllWindows()) {
          try {
            window.webContents.send('dubbing:sessionsDeleted', ids);
          } catch {
            /* closed window */
          }
        }
        items
          .filter((item) => item.type === 'download')
          .forEach((item) => cancelDownloadBatch(item.id));
      },
    };
  });
  ipcMain.handle('getWorkItems', () => getWorkItems());

  ipcMain.handle('getWorkItem', (_event, id: string) => getWorkItemById(id));

  ipcMain.handle('saveWorkItem', (_event, item: WorkItem) =>
    saveWorkItem(item, { durable: true }),
  );

  ipcMain.handle('deleteWorkItem', (_event, id: string) => {
    return deleteWorkItem(id);
  });

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

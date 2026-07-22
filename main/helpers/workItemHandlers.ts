import { ipcMain } from 'electron';
import {
  deleteWorkItem,
  getWorkItemById,
  getWorkItems,
  renameWorkItem,
  saveWorkItem,
  clearAllWorkItems,
} from './workItemStore';
import { deleteDubbingSessionData } from './dubbing/dubbingProcessor';
import { cancelDownloadBatch } from './videoDownload/scheduler';
import type { WorkItem } from '../../types/workItem';

/** 工作项删除时联动清理配音会话目录（行级 wav + 元数据） */
function cleanupDubbingSession(item: WorkItem | null): void {
  if (!item) return;
  if (item.type === 'download') {
    // 删除进行中的下载批次：先停进程/清队列（已落盘文件保留）
    cancelDownloadBatch(item.id);
    return;
  }
  if (item.type === 'dubbing') {
    const sessionId = (
      item.configSnapshot as { sessionId?: string } | undefined
    )?.sessionId;
    if (sessionId) deleteDubbingSessionData(sessionId);
    return;
  }
  // 流水线任务：各文件的配音阶段会话一并清理
  for (const file of item.pipelineFiles ?? []) {
    const sessionId = (file as { dubbingSessionId?: string }).dubbingSessionId;
    if (sessionId) deleteDubbingSessionData(sessionId);
  }
}

export function setupWorkItemHandlers(): void {
  ipcMain.handle('getWorkItems', () => getWorkItems());

  ipcMain.handle('getWorkItem', (_event, id: string) => getWorkItemById(id));

  ipcMain.handle('saveWorkItem', (_event, item: WorkItem) =>
    saveWorkItem(item),
  );

  ipcMain.handle('deleteWorkItem', (_event, id: string) => {
    cleanupDubbingSession(getWorkItemById(id));
    return deleteWorkItem(id);
  });

  ipcMain.handle(
    'renameWorkItem',
    (_event, payload: { id: string; name: string }) =>
      renameWorkItem(payload?.id, payload?.name || ''),
  );

  ipcMain.handle('clearAllWorkItems', () => {
    for (const item of getWorkItems()) {
      cleanupDubbingSession(item);
    }
    clearAllWorkItems();
    return true;
  });
}

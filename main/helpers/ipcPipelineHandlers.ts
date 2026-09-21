/**
 * 流水线人工检查点 IPC：放行（单文件/批量）。
 * 放行后以主窗口 webContents 广播文件状态变更，打开中的任务页即时刷新。
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logMessage } from './storeManager';
import { releaseGate } from './pipeline/gateManager';
import { getWorkItemById } from './workItemStore';
import type { GateKind } from './pipeline/gateLogic';
import { filterReleasableFiles } from './pipeline/gateLogic';
import { dubbingSessionOwnership } from './dubbing/sessionOwnership';
import { readConfigDraft, readCueDraft } from './dubbing/configDraftStore';
import { getDubbingSession } from './dubbing/dubbingProcessor';

export function setupPipelineHandlers(mainWindow: BrowserWindow) {
  ipcMain.handle(
    'pipeline:releaseGate',
    async (
      event,
      {
        projectId,
        gate,
        fileUuids,
        leaseId,
      }: {
        projectId: string;
        gate: GateKind;
        fileUuids?: string[];
        leaseId?: string;
      },
    ) => {
      const releasedEditors: string[] = [];
      if (gate === 'dubbing') {
        const targets = filterReleasableFiles(
          getWorkItemById(projectId)?.pipelineFiles || [],
          gate,
          fileUuids,
        );
        for (const file of targets) {
          const id = file.dubbingSessionId;
          if (!id) continue;
          const owner = dubbingSessionOwnership.owner(id);
          if (
            (dubbingSessionOwnership.isBusy(id) &&
              (!owner ||
                !dubbingSessionOwnership.owns(id, event.sender.id, leaseId))) ||
            getDubbingSession(id)?.running ||
            readConfigDraft(id) !== null ||
            readCueDraft(id) !== null
          )
            return {
              success: false,
              error:
                'Dubbing project is busy or has unconfirmed edits; save or discard edits and close other editors before releasing',
            };
          if (owner) releasedEditors.push(id);
        }
      }
      releasedEditors.forEach((id) =>
        dubbingSessionOwnership.release(id, event.sender.id, leaseId),
      );
      let result: ReturnType<typeof releaseGate>;
      try {
        result = releaseGate(projectId, gate, fileUuids);
      } catch (error) {
        releasedEditors.forEach((id) =>
          dubbingSessionOwnership.acquire(id, event.sender.id, leaseId),
        );
        return { success: false, error: String(error) };
      }
      if ('error' in result) {
        releasedEditors.forEach((id) =>
          dubbingSessionOwnership.acquire(id, event.sender.id, leaseId),
        );
        return { success: false, error: result.error };
      }
      if (releasedEditors.length)
        dubbingSessionOwnership.retire(event.sender.id, leaseId);
      // 即时把 passed 状态推给打开中的任务页（派发后的执行事件随后自然续接）
      if (result.released > 0 && !mainWindow.isDestroyed()) {
        const item = getWorkItemById(projectId);
        const field = gate === 'subtitle' ? 'subtitleGate' : 'dubbingGate';
        for (const file of item?.pipelineFiles ?? []) {
          if ((file as any)[field] === 'passed') {
            try {
              mainWindow.webContents.send('taskFileChange', {
                ...file,
                taskProjectId: projectId,
              });
            } catch {
              /* ignore */
            }
          }
        }
      }
      return { success: true, data: result };
    },
  );

  logMessage('流水线检查点 IPC 处理函数已注册', 'info');
}

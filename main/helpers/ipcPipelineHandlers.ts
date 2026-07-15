/**
 * 流水线人工检查点 IPC：放行（单文件/批量）。
 * 放行后以主窗口 webContents 广播文件状态变更，打开中的任务页即时刷新。
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logMessage } from './storeManager';
import { releaseGate } from './pipeline/gateManager';
import { getWorkItemById } from './workItemStore';
import type { GateKind } from './pipeline/gateLogic';

export function setupPipelineHandlers(mainWindow: BrowserWindow) {
  ipcMain.handle(
    'pipeline:releaseGate',
    async (
      _event,
      {
        projectId,
        gate,
        fileUuids,
      }: { projectId: string; gate: GateKind; fileUuids?: string[] },
    ) => {
      const result = releaseGate(projectId, gate, fileUuids);
      if ('error' in result) {
        return { success: false, error: result.error };
      }
      // 即时把 passed 状态推给打开中的任务页（派发后的执行事件随后自然续接）
      if (result.released > 0 && !mainWindow.isDestroyed()) {
        const item = getWorkItemById(projectId);
        const field = gate === 'subtitle' ? 'subtitleGate' : 'dubbingGate';
        for (const file of item?.pipelineFiles ?? []) {
          if ((file as any)[field] === 'passed') {
            try {
              mainWindow.webContents.send('taskFileChange', file);
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

/**
 * Python 引擎 PoC 的 IPC 入口。
 *
 * 渲染进程验证方式(DevTools Console):
 *   await window.ipc.invoke('pythonEngine:ping')
 *   window.ipc.on('pythonEngine:progress', console.log)
 *   await window.ipc.invoke('pythonEngine:testTranscribe', { durationS: 3, segmentCount: 6 })
 *   await window.ipc.invoke('pythonEngine:stop')
 */
import { ipcMain } from 'electron';
import { logMessage } from './storeManager';
import { getPythonEngineManager, shutdownPythonEngine } from './pythonEngine';

function toErrorPayload(error: unknown): { code?: string; message: string } {
  const err = error as { code?: string; message?: string };
  return {
    code: err?.code,
    message: err?.message || String(error),
  };
}

export function registerPythonEngineIpcHandlers(): void {
  ipcMain.handle('pythonEngine:ping', async () => {
    try {
      const info = await getPythonEngineManager().ensureStarted();
      return { success: true, info };
    } catch (error) {
      logMessage(`pythonEngine:ping failed: ${error}`, 'error');
      return { success: false, error: toErrorPayload(error) };
    }
  });

  // PoC:用 fake 引擎演示完整链路(启动 -> 进度/分段事件 -> 结果)
  ipcMain.handle('pythonEngine:testTranscribe', async (event, options) => {
    try {
      const manager = getPythonEngineManager();
      await manager.ensureStarted();

      const { id, result } = manager.transcribe(
        {
          engine: 'fake',
          duration_s: options?.durationS ?? 2,
          segment_count: options?.segmentCount ?? 5,
        },
        {
          onProgress: (percent) =>
            event.sender.send('pythonEngine:progress', { id, percent }),
          onSegment: (segment) =>
            event.sender.send('pythonEngine:segment', { id, segment }),
        },
      );

      const transcription = await result;
      return { success: true, id, result: transcription };
    } catch (error) {
      logMessage(`pythonEngine:testTranscribe failed: ${error}`, 'error');
      return { success: false, error: toErrorPayload(error) };
    }
  });

  ipcMain.handle('pythonEngine:cancel', (event, id: string) => {
    getPythonEngineManager().cancel(id);
    return { success: true };
  });

  ipcMain.handle('pythonEngine:stop', async () => {
    await shutdownPythonEngine();
    return { success: true };
  });
}

/**
 * Python 引擎 PoC 的 IPC 入口。
 *
 * 渲染进程验证方式(DevTools Console):
 *   await window.ipc.invoke('pythonEngine:ping')
 *   window.ipc.on('pythonEngine:progress', console.log)
 *   await window.ipc.invoke('pythonEngine:testTranscribe', { durationS: 3, segmentCount: 6 })
 *   // 真实转写(需 python-engine/.venv 已安装 faster-whisper;支持音频或视频路径):
 *   await window.ipc.invoke('pythonEngine:transcribeFile', { audioFile: '/path/to/media.mp4', model: 'tiny' })
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

  // 真实 faster-whisper 转写:audioFile 支持任意 ffmpeg 可解码的音/视频路径,
  // model 可为 faster-whisper 模型 id(tiny/base/small/...)或 CT2 模型目录绝对路径
  ipcMain.handle('pythonEngine:transcribeFile', async (event, options) => {
    const audioFile = options?.audioFile;
    if (!audioFile) {
      return { success: false, error: { message: 'audioFile is required' } };
    }
    try {
      const manager = getPythonEngineManager();
      await manager.ensureStarted();

      const { id, result } = manager.transcribe(
        {
          engine: 'faster_whisper',
          audio_file: audioFile,
          model: options?.model ?? 'tiny',
          language: options?.language ?? 'auto',
          device: options?.device ?? 'auto',
          compute_type: options?.computeType ?? 'auto',
          vad: options?.vad ?? true,
          word_timestamps: options?.wordTimestamps ?? false,
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
      logMessage(`pythonEngine:transcribeFile failed: ${error}`, 'error');
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

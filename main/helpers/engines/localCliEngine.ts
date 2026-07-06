import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { EngineStatus } from '../../../types/engine';
import { logMessage, store } from '../storeManager';
import { getTaskContext, TaskCancelledError } from '../taskContext';
import { getWhisperLanguage } from './transcribeShared';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

/** 在途 CLI 子进程集合：任务级并发下可能同时存在多个，取消须精确到进程。 */
const activeLocalCliChildren = new Set<ChildProcess>();

function killLocalCliChild(child: ChildProcess): void {
  if (child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      // 杀整棵进程树（whisper CLI 常 fork 子进程）
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // 进程可能已退出
  }
}

function cancelLocalCliTranscription(): void {
  activeLocalCliChildren.forEach((child) => killLocalCliChild(child));
  activeLocalCliChildren.clear();
}

/**
 * 使用本地 Whisper 命令行工具生成字幕。取消时 kill 子进程树。
 */
function transcribeLocalCli(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  const { model, sourceLanguage } = formData as {
    model?: string;
    sourceLanguage?: string;
  };
  const whisperModel = model?.toLowerCase();
  const settings = store.get('settings');
  const whisperCommand = settings?.whisperCommand;
  const { tempAudioFile, srtFile, directory } = file;

  let runShell = whisperCommand
    .replace(/\${audioFile}/g, tempAudioFile)
    .replace(/\${whisperModel}/g, whisperModel)
    .replace(/\${srtFile}/g, srtFile)
    .replace(/\${sourceLanguage}/g, getWhisperLanguage(sourceLanguage))
    .replace(/\${outputDir}/g, directory);

  runShell = runShell.replace(/("[^"]*")|(\S+)/g, (match, quoted, unquoted) => {
    if (quoted) return quoted;
    if (unquoted && (unquoted.includes('/') || unquoted.includes('\\'))) {
      return `"${unquoted}"`;
    }
    return unquoted || match;
  });

  logMessage(`run shell ${runShell}`, 'info');
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  return new Promise<string>((resolve, reject) => {
    const signal = ctx.signal ?? getTaskContext()?.signal;
    if (signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }

    const child = spawn(runShell, { shell: true, windowsHide: true });
    activeLocalCliChildren.add(child);
    let stderrBuf = '';
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      // 只终止本任务的子进程，不波及并发中的其它任务
      killLocalCliChild(child);
      activeLocalCliChildren.delete(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d) =>
      logMessage(`localCli stdout: ${d}`, 'info'),
    );
    child.stderr?.on('data', (d) => {
      stderrBuf += String(d);
    });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      activeLocalCliChildren.delete(child);
      if (cancelled || signal?.aborted) {
        reject(new TaskCancelledError());
        return;
      }
      logMessage(`generate subtitle error: ${error}`, 'error');
      reject(error);
    });

    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      activeLocalCliChildren.delete(child);

      if (cancelled || signal?.aborted) {
        reject(new TaskCancelledError());
        return;
      }
      if (code !== 0) {
        logMessage(
          `localCli exited code=${code} signal=${sig}: ${stderrBuf}`,
          'error',
        );
        reject(
          new Error(
            `whisper command failed (code=${code}): ${stderrBuf.slice(0, 500)}`,
          ),
        );
        return;
      }
      if (stderrBuf.trim()) {
        logMessage(`generate subtitle stderr: ${stderrBuf}`, 'warning');
      }
      logMessage(`generate subtitle done!`, 'info');

      const md5BaseName = path.basename(tempAudioFile, '.wav');
      const tempSrtFile = path.join(directory, `${md5BaseName}.srt`);
      if (fs.existsSync(tempSrtFile)) {
        fs.renameSync(tempSrtFile, srtFile);
      }

      event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
      resolve(srtFile);
    });
  });
}

export const localCliEngineAdapter: TranscriptionEngineAdapter = {
  id: 'localCli',
  displayName: 'Local Whisper CLI',
  requiresRuntime: false,

  async isAvailable(): Promise<EngineStatus> {
    const whisperCommand = store.get('settings')?.whisperCommand;
    if (!whisperCommand?.trim()) {
      return {
        state: 'not_installed',
        message: 'Whisper command is not configured',
      };
    }
    return { state: 'ready' };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeLocalCli(ctx);
  },

  cancelActive(): void {
    cancelLocalCliTranscription();
  },
};

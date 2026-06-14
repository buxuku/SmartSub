import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getPath, loadWhisperAddon } from './whisper';
import { logMessage, store } from './storeManager';
import {
  getFasterWhisperModelsPath,
  resolveCt2ModelSnapshotDir,
} from './modelCatalog';
import { formatSrtContent } from './fileUtils';
import { IFiles } from '../../types';
import { getExtraResourcesPath } from './utils';
import { getPythonRuntimeManager } from './pythonRuntime';
import { toFasterWhisperModel } from './engines/modelMap';
import {
  getTaskContext,
  isWhisperAbortError,
  isWhisperCancelledResult,
  TaskCancelledError,
  throwIfTaskCancelled,
} from './taskContext';

let activeLocalCliChild: ChildProcess | null = null;

export function cancelLocalCliTranscription(): void {
  const child = activeLocalCliChild;
  if (!child || child.pid == null) return;
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
  activeLocalCliChild = null;
}

function getNumericSetting(value: unknown, defaultValue: number): number {
  return typeof value === 'number' && isFinite(value) ? value : defaultValue;
}

function getWhisperLanguage(language?: string): string {
  if (!language || language === 'auto') {
    return 'auto';
  }

  const normalized = language.toLowerCase();
  // 所有中文变体（简体/繁体/台湾/香港等）统一映射为 zh，
  // Whisper 对 zh 的训练数据最充分，识别国语/普通话最准确；
  // 粤语请通过下拉框单独选择 yue 传入。
  if (normalized.startsWith('zh')) {
    return 'zh';
  }

  return normalized;
}

function secondsToSrtTime(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds || 0) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, len = 2) => String(value).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/**
 * 使用本地Whisper命令行工具生成字幕
 */
export async function generateSubtitleWithLocalWhisper(
  event,
  file,
  formData,
): Promise<string> {
  const { model, sourceLanguage } = formData;
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

  console.log(runShell, 'runShell');
  logMessage(`run shell ${runShell}`, 'info');
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  return new Promise<string>((resolve, reject) => {
    const signal = getTaskContext()?.signal;
    if (signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }

    const child = spawn(runShell, { shell: true, windowsHide: true });
    activeLocalCliChild = child;
    let stderrBuf = '';
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      cancelLocalCliTranscription();
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
      if (activeLocalCliChild === child) activeLocalCliChild = null;
      if (cancelled || signal?.aborted) {
        reject(new TaskCancelledError());
        return;
      }
      logMessage(`generate subtitle error: ${error}`, 'error');
      reject(error);
    });

    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (activeLocalCliChild === child) activeLocalCliChild = null;

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

import { spawn, type ChildProcess } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { logMessage } from './logger';
import {
  parseSubtitleStreams,
  type EmbeddedSubtitleStream,
} from './embeddedSubtitleParser';

// 打包后 ffmpeg 位于 app.asar.unpacked（与 audioProcessor 一致）
const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

/**
 * 探测视频内封字幕流：spawn 内置 ffmpeg `-i` 解析 stderr，永不 reject。
 * ffmpeg 因无输出文件以非零码退出属正常，照常解析 stderr。带超时保护。
 *
 * `signal` 中止时立即终止子进程并返回空数组（不记警告）：开始任务前的批量探测
 * 命中一个就中止其余，并用它兜住整体时间预算。已中止的 signal 不会 spawn。
 * 子进程隐藏控制台窗口：Windows 上批量 spawn 控制台程序会闪窗。
 */
export function probeEmbeddedSubtitles(
  videoPath: string,
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<EmbeddedSubtitleStream[]> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve([]);
      return;
    }
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    const kill = () => {
      try {
        child?.kill('SIGKILL');
      } catch {}
    };
    const onAbort = () => {
      kill();
      done([]);
    };
    const done = (result: EmbeddedSubtitleStream[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-i', videoPath], {
        // 只读 stderr；stdin / stdout 用不到，不建管道
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      logMessage(`probe embedded subtitle spawn failed: ${err}`, 'warning');
      resolve([]);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      kill();
      logMessage(`probe embedded subtitle timeout: ${videoPath}`, 'warning');
      done([]);
    }, timeoutMs);
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      logMessage(`probe embedded subtitle error: ${err}`, 'warning');
      done([]);
    });
    child.on('close', () => {
      try {
        done(parseSubtitleStreams(stderr));
      } catch (err) {
        logMessage(`parse subtitle streams failed: ${err}`, 'warning');
        done([]);
      }
    });
  });
}

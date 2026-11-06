import path from 'path';
import { getExtraResourcesPath } from '../utils';
import {
  getSherpaLibDir,
  isSherpaLibInstalled,
} from '../sherpaOnnx/sherpaLibPaths';
import { spawnAppUtilityHost } from '../crash/appUtilityHost';
import { beginCrashContext } from '../crash/crashContext';
import { buildSherpaWorkerEnv, type UtilityHost } from '../crash/utilityHost';
import type { SpeakerDiarizationSegment } from './alignment';

interface PendingDiarization {
  process: UtilityHost;
  resolve: (segments: SpeakerDiarizationSegment[]) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface SpeakerDiarizationWorkerMessage {
  id?: string;
  type?: 'done' | 'error';
  segments?: SpeakerDiarizationSegment[];
  message?: string;
}

function workerPath(): string {
  return path.join(
    getExtraResourcesPath(),
    'sherpa',
    'worker',
    'speaker-diarization-worker.js',
  );
}

/**
 * 每个请求使用独立 utilityProcess。diarization 的原生 `process()` 是同步长调用，
 * 独立进程让取消可以通过 kill 立即生效，也避免一个文件的 native 崩溃影响其它任务。
 */
class SpeakerDiarizationRuntime {
  private seq = 0;
  private pending = new Map<string, PendingDiarization>();

  diarize(input: {
    audioFile: string;
    segmentationModel: string;
    embeddingModel: string;
    numClusters?: number;
    numThreads?: number;
  }): {
    id: string;
    result: Promise<{ segments: SpeakerDiarizationSegment[] }>;
  } {
    if (!isSherpaLibInstalled()) {
      throw new Error('sherpa native lib not installed');
    }

    const id = `sd${++this.seq}`;
    // fork / stderr 日志 / 退出分类 / Linux core 限制由共用底座处理（crash/utilityHost.ts）
    const child = spawnAppUtilityHost({
      workerFile: workerPath(),
      serviceName: 'smartsub-speaker-diarization',
      logLabel: 'speaker diarization worker',
      env: buildSherpaWorkerEnv(getSherpaLibDir()),
    });
    // 崩溃现场：请求结束（成功、失败、取消、进程退出）时移除
    const endContext = beginCrashContext({
      engine: 'speaker-diarization',
      model: input.segmentationModel,
      phase: 'diarize',
    });

    const result = new Promise<{ segments: SpeakerDiarizationSegment[] }>(
      (resolve, reject) => {
        const entry: PendingDiarization = {
          process: child,
          resolve: (segments) => resolve({ segments }),
          reject,
          settled: false,
        };
        this.pending.set(id, entry);

        child.onMessage((message: SpeakerDiarizationWorkerMessage) => {
          if (message?.id !== id || entry.settled) return;
          if (message.type === 'done') {
            entry.settled = true;
            this.pending.delete(id);
            entry.resolve(message.segments || []);
            child.kill();
          } else if (message.type === 'error') {
            entry.settled = true;
            this.pending.delete(id);
            entry.reject(new Error(message.message || 'diarization failed'));
            child.kill();
          }
        });
        child.onExit(({ code }) => {
          if (entry.settled) return;
          entry.settled = true;
          this.pending.delete(id);
          const error = new Error(
            code === 0
              ? 'speaker diarization worker exited before returning a result'
              : `speaker diarization worker exited abnormally (code ${code})`,
          ) as Error & { code?: string };
          error.code = 'worker_exit';
          entry.reject(error);
        });

        child.postMessage({ type: 'diarize', id, ...input });
      },
    );
    result.then(endContext, endContext);

    return { id, result };
  }

  private stop(id: string, code: 'cancelled' | 'disposed'): void {
    const entry = this.pending.get(id);
    if (!entry || entry.settled) return;
    entry.settled = true;
    this.pending.delete(id);
    const error = new Error(code) as Error & { code?: string };
    error.code = code;
    entry.reject(error);
    entry.process.kill();
  }

  cancel(id: string): void {
    this.stop(id, 'cancelled');
  }

  dispose(): void {
    for (const id of Array.from(this.pending.keys())) {
      this.stop(id, 'disposed');
    }
  }
}

let runtime: SpeakerDiarizationRuntime | null = null;

export function getSpeakerDiarizationRuntime(): SpeakerDiarizationRuntime {
  if (!runtime) runtime = new SpeakerDiarizationRuntime();
  return runtime;
}

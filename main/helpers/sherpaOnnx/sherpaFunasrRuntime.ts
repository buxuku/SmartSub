import path from 'path';
import { Worker } from 'worker_threads';
import { logMessage } from '../storeManager';
import { getExtraResourcesPath } from '../utils';
import { getSherpaLibDir, isSherpaLibInstalled } from './sherpaLibPaths';
import type { FunasrAddonParams } from '../engines/funasrParams';

export interface SherpaModelRequest {
  asrModel: string;
  tokens: string;
  vadModel: string;
  modelType: 'sense_voice' | 'paraformer';
  params: FunasrAddonParams;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

function workerPath(): string {
  return path.join(
    getExtraResourcesPath(),
    'sherpa',
    'worker',
    'sherpa-worker.js',
  );
}

/**
 * 主侧 sherpa funasr 运行时：常驻一个 worker（worker 内 dlopen 原生库、缓存识别器），
 * 提供 prewarm / transcribe / cancel / dispose。模型加载与解码均在 worker 线程，
 * 不阻塞主/UI 线程——根治 Windows 首个 transcribe 卡 0%。
 */
class SherpaFunasrRuntime {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<
    string,
    {
      resolve: (s: { segments: Segment[] }) => void;
      reject: (e: Error) => void;
      onProgress?: (p: number) => void;
    }
  >();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!isSherpaLibInstalled()) {
      throw new Error('sherpa native lib not installed');
    }
    const libDir = getSherpaLibDir();
    const w = new Worker(workerPath(), {
      env: {
        ...process.env,
        SHERPA_ONNX_LIB_DIR: libDir,
        // Windows DLL / Linux SO 依赖解析（macOS 靠 @loader_path 重写）。
        PATH: `${libDir}${path.delimiter}${process.env.PATH ?? ''}`,
        LD_LIBRARY_PATH: `${libDir}${path.delimiter}${
          process.env.LD_LIBRARY_PATH ?? ''
        }`,
      },
    });
    w.on('message', (msg: any) => this.onMessage(msg));
    w.on('error', (e) => this.failAll(e));
    w.on('exit', (code) => {
      if (code !== 0) this.failAll(new Error(`sherpa worker exited ${code}`));
      this.worker = null;
    });
    this.worker = w;
    return w;
  }

  private onMessage(msg: any): void {
    if (msg.type === 'ready') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'progress') {
      entry.onProgress?.(msg.percent);
    } else if (msg.type === 'done') {
      this.pending.delete(msg.id);
      entry.resolve({ segments: msg.segments });
    } else if (msg.type === 'error') {
      this.pending.delete(msg.id);
      const err = new Error(msg.message) as Error & { code?: string };
      if (msg.code) err.code = msg.code;
      entry.reject(err);
    }
  }

  private failAll(e: Error): void {
    this.pending.forEach((entry) => entry.reject(e));
    this.pending.clear();
  }

  /** 预热：仅 load 模型，不转写。失败非致命。 */
  prewarm(model: SherpaModelRequest): void {
    try {
      this.ensureWorker().postMessage({ type: 'load', ...model });
    } catch (e) {
      logMessage(`sherpa prewarm skipped: ${e}`, 'warning');
    }
  }

  transcribe(
    model: SherpaModelRequest,
    audioFile: string,
    onProgress?: (p: number) => void,
  ): { id: string; result: Promise<{ segments: Segment[] }> } {
    const w = this.ensureWorker();
    const id = `t${++this.seq}`;
    const result = new Promise<{ segments: Segment[] }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
    });
    w.postMessage({ type: 'transcribe', id, audioFile, ...model });
    return { id, result };
  }

  cancel(id: string): void {
    this.worker?.postMessage({ type: 'cancel', id });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

let runtime: SherpaFunasrRuntime | null = null;

export function getSherpaFunasrRuntime(): SherpaFunasrRuntime {
  if (!runtime) runtime = new SherpaFunasrRuntime();
  return runtime;
}

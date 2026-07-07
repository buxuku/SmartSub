import path from 'path';
import fs from 'fs';
import { Worker } from 'worker_threads';
import { logMessage } from '../storeManager';
import { getExtraResourcesPath } from '../utils';
import { getSherpaLibDir, isSherpaLibInstalled } from './sherpaLibPaths';
import { readPcm16Wav } from '../audioProcessor';

/** worker 侧 buildTtsConfig 消费的模型描述（绝对路径由 catalog 侧拼好）。 */
export interface TtsModelRequest {
  modelFamily: 'kokoro' | 'vits';
  files: {
    model: string;
    tokens: string;
    /** kokoro：voices.bin */
    voices?: string;
    /** kokoro：espeak-ng-data 目录 */
    dataDir?: string;
    /** 逗号分隔词典（kokoro 中英双词典 / vits 单词典） */
    lexicon: string;
    /** 逗号分隔归一化规则 fst（可为空） */
    ruleFsts?: string;
  };
  numThreads?: number;
}

export interface TtsSynthesisResult {
  samples: Float32Array;
  sampleRate: number;
}

export interface TtsModelMeta {
  numSpeakers: number;
  sampleRate: number;
}

/** 单句合成超时（探索实测 kokoro RTF≈0.61，60s 覆盖 ~90s 台词，远超单句常规长度）。 */
const SYNTHESIZE_TIMEOUT_MS = 60_000;

function workerPath(): string {
  return path.join(
    getExtraResourcesPath(),
    'sherpa',
    'worker',
    'tts-worker.js',
  );
}

/**
 * 主侧 sherpa TTS 运行时：常驻一个独立 worker（与 ASR worker 分进程），
 * 提供 load / synthesize / cancel / dispose。模型加载与合成均在 worker 线程。
 * 逐句合成天然串行（worker 内同步推理），主侧 pending 表支持并发请求排队。
 */
class SherpaTtsRuntime {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<
    string,
    {
      resolve: (r: TtsSynthesisResult) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private loadWaiter: {
    resolve: (meta: TtsModelMeta) => void;
    reject: (e: Error) => void;
  } | null = null;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (!isSherpaLibInstalled()) {
      throw new Error('sherpa native lib not installed');
    }
    const libDir = getSherpaLibDir();
    const wp = workerPath();
    logMessage(`starting tts worker: ${wp}`, 'info');
    const w = new Worker(wp, {
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
      if (code !== 0) this.failAll(new Error(`tts worker exited ${code}`));
      this.worker = null;
    });
    this.worker = w;
    return w;
  }

  private onMessage(msg: any): void {
    if (msg.type === 'ready') {
      this.loadWaiter?.resolve({
        numSpeakers: msg.numSpeakers,
        sampleRate: msg.sampleRate,
      });
      if (msg.protocol) {
        logMessage(`tts worker ready (${msg.protocol})`, 'info');
      }
      this.loadWaiter = null;
      return;
    }
    if (msg.type === 'error' && msg.id === 'load') {
      this.loadWaiter?.reject(new Error(msg.message));
      this.loadWaiter = null;
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (msg.type === 'done') {
      this.pending.delete(msg.id);
      const wavPath = msg.wavPath as string | undefined;
      if (!wavPath) {
        entry.reject(new Error('tts worker: missing wavPath'));
        return;
      }
      try {
        const decoded = readPcm16Wav(wavPath);
        entry.resolve({
          samples: decoded.samples,
          sampleRate: msg.sampleRate ?? decoded.sampleRate,
        });
      } catch (e) {
        entry.reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        try {
          if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        } catch {
          /* ignore */
        }
      }
    } else if (msg.type === 'error') {
      this.pending.delete(msg.id);
      const err = new Error(msg.message) as Error & { code?: string };
      if (msg.code) err.code = msg.code;
      entry.reject(err);
    }
  }

  private failAll(e: Error): void {
    this.pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(e);
    });
    this.pending.clear();
    this.loadWaiter?.reject(e);
    this.loadWaiter = null;
  }

  /** 加载模型（幂等：worker 侧按 modelFamily+model 路径缓存），返回音色数与采样率。 */
  load(model: TtsModelRequest): Promise<TtsModelMeta> {
    const w = this.ensureWorker();
    return new Promise<TtsModelMeta>((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      w.postMessage({ type: 'load', ...model });
    });
  }

  /**
   * 逐句合成。speed 固定 1.0 由调用方保证（时长压缩走 atempo 后置，见 design D3），
   * 但参数保留以供试听等场景微调。返回 id 供取消。
   */
  synthesize(
    model: TtsModelRequest,
    text: string,
    sid: number,
    speed = 1.0,
    signal?: AbortSignal,
  ): { id: string; result: Promise<TtsSynthesisResult> } {
    const w = this.ensureWorker();
    const id = `s${++this.seq}`;
    const result = new Promise<TtsSynthesisResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 看门狗超时：worker 可能卡死在 native 推理，回收整个 worker
        this.dispose();
        reject(
          new Error(`tts synthesize timeout (${SYNTHESIZE_TIMEOUT_MS}ms)`),
        );
      }, SYNTHESIZE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      if (signal?.aborted) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('cancelled'));
        return;
      }
    });
    w.postMessage({ type: 'synthesize', id, text, sid, speed, ...model });
    return { id, result };
  }

  cancel(id: string): void {
    this.worker?.postMessage({ type: 'cancel', id });
  }

  dispose(): void {
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.terminate().catch((e) => {
        logMessage(`tts worker terminate failed: ${e}`, 'warning');
      });
    }
    this.failAll(new Error('tts runtime disposed'));
  }
}

let runtime: SherpaTtsRuntime | null = null;

export function getSherpaTtsRuntime(): SherpaTtsRuntime {
  if (!runtime) runtime = new SherpaTtsRuntime();
  return runtime;
}

/** 任务结束或取消后释放 worker（dev 下可重新加载 worker 脚本）。 */
export function releaseSherpaTtsRuntime(): void {
  runtime?.dispose();
  runtime = null;
}

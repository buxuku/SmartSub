import path from 'path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { logMessage } from '../storeManager';
import { getExtraResourcesPath } from '../utils';
import { getSherpaLibDir, isSherpaLibInstalled } from './sherpaLibPaths';

/**
 * TTS 模型加载请求：文件绝对路径由 catalog / 调用方拼好。
 * 与 extraResources/sherpa/worker/tts-config.js 的 TtsModelRequest 同构
 * （配置构建只在 worker 侧经 tts-config.js 完成，主侧不复制该逻辑）。
 */
export interface TtsModelRequest {
  modelType: 'kokoro' | 'vits' | 'zipvoice';
  /** kokoro / vits 模型 onnx。 */
  model?: string;
  tokens: string;
  voices?: string;
  lexicon?: string;
  dataDir?: string;
  dictDir?: string;
  ruleFsts?: string;
  /** zipvoice 三工件。 */
  encoder?: string;
  decoder?: string;
  vocoder?: string;
  numThreads?: number;
  provider?: string;
}

/** 零样本克隆合成参数（zipvoice）：参考音频路径由 worker 侧读取并缓存。 */
export interface TtsGenerationConfig {
  refWavPath: string;
  refText: string;
  /** 生成质量/速度权衡（默认 4）。 */
  numSteps?: number;
}

export interface TtsSynthesisResult {
  sampleRate: number;
  numSamples: number;
  durationMs: number;
}

function workerPath(): string {
  return path.join(
    getExtraResourcesPath(),
    'sherpa',
    'worker',
    'tts-worker.js',
  );
}

/** 池上限（每进程一份模型驻留内存，zipvoice 实测单进程峰值 ~1.5GB）。 */
export const TTS_POOL_MAX = 3;

interface TtsWorkerHandle {
  proc: UtilityProcess;
  /** 在途请求数（派发选最闲者）。 */
  busy: number;
  alive: boolean;
}

/**
 * 主侧本地 TTS 运行时：独立 worker **进程池**（Electron utilityProcess，
 * 上限 3、默认 1、按需扩展）。与 ASR worker 分进程；worker 内 dlopen 原生库、
 * 按参数缓存 OfflineTts 实例。native 层崩溃只死对应子进程——该进程在途请求
 * reject、成员移池，其余成员与主进程不受影响（worker_threads 时代 SIGTRAP
 * 直接带崩整个应用，2026-07-09 真机事故）。批量结束后 shrinkTo(1) 回收
 * 多余空闲进程，避免多份模型常驻内存。
 * 提供 prewarm / synthesize / cancel / setPoolSize / shrinkTo / dispose。
 */
class SherpaTtsRuntime {
  private pool: TtsWorkerHandle[] = [];
  private poolSize = 1;
  private seq = 0;
  private pending = new Map<
    string,
    {
      resolve: (r: TtsSynthesisResult) => void;
      reject: (e: Error) => void;
      handle: TtsWorkerHandle;
    }
  >();

  /** 目标池量（1..TTS_POOL_MAX）；扩张按需、收缩走 shrinkTo。 */
  setPoolSize(n: number): void {
    const size = Math.max(1, Math.min(TTS_POOL_MAX, Math.floor(n) || 1));
    this.poolSize = size;
  }

  /** 收缩池到 n：仅回收空闲成员（在途的自然跑完后由下次 shrink 回收）。 */
  shrinkTo(n: number): void {
    const target = Math.max(1, Math.min(TTS_POOL_MAX, Math.floor(n) || 1));
    this.poolSize = target;
    let toRemove = this.pool.length - target;
    if (toRemove <= 0) return;
    let removed = 0;
    this.pool = this.pool.filter((h) => {
      if (toRemove <= 0 || h.busy > 0) return true;
      h.alive = false;
      try {
        h.proc.postMessage({ type: 'dispose' });
        h.proc.kill();
      } catch {
        /* ignore */
      }
      toRemove -= 1;
      removed += 1;
      return false;
    });
    if (removed > 0) {
      logMessage(`tts pool shrunk by ${removed} (target ${target})`, 'info');
    }
  }

  private spawnWorker(): TtsWorkerHandle {
    if (!isSherpaLibInstalled()) {
      throw new Error('sherpa native lib not installed');
    }
    const libDir = getSherpaLibDir();
    const proc = utilityProcess.fork(workerPath(), [], {
      serviceName: 'smartsub-tts-worker',
      stdio: 'pipe',
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
    const handle: TtsWorkerHandle = { proc, busy: 0, alive: true };
    proc.on('message', (msg: any) => this.onMessage(handle, msg));
    // native 崩溃前的 stderr 是关键诊断线索（onnxruntime/sherpa 报错都走这里）。
    proc.stderr?.on('data', (d: Buffer) => {
      const line = String(d).trim();
      if (line) logMessage(`tts worker stderr: ${line}`, 'warning');
    });
    proc.on('exit', (code) => {
      // shrinkTo/dispose 先置 alive=false 再 kill：此时的非零退出码是
      // 信号终止的垃圾值（如 0x6B0E7680），属预期停止，不按异常处理。
      const expected = !handle.alive;
      handle.alive = false;
      this.pool = this.pool.filter((h) => h !== handle);
      if (expected) {
        this.failOwn(
          handle,
          new Error('本地 TTS 引擎已释放（模型切换/回收），请重试'),
        );
        return;
      }
      if (code !== 0) {
        this.failOwn(
          handle,
          new Error(
            `本地 TTS 引擎异常退出（code ${code}），已自动重置，请重试`,
          ),
        );
        logMessage(`tts worker exited abnormally (code ${code})`, 'error');
      }
    });
    this.pool.push(handle);
    return handle;
  }

  /** 派发目标：在途最少的存活成员；池未达目标量则扩员。 */
  private pickWorker(): TtsWorkerHandle {
    if (this.pool.length < this.poolSize) return this.spawnWorker();
    if (this.pool.length === 0) return this.spawnWorker();
    let best = this.pool[0];
    for (const h of this.pool) {
      if (h.busy < best.busy) best = h;
    }
    return best;
  }

  private onMessage(handle: TtsWorkerHandle, msg: any): void {
    if (msg.type === 'ready') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    entry.handle.busy = Math.max(0, entry.handle.busy - 1);
    if (msg.type === 'done') {
      entry.resolve({
        sampleRate: msg.sampleRate,
        numSamples: msg.numSamples,
        durationMs: msg.durationMs,
      });
    } else if (msg.type === 'error') {
      const err = new Error(msg.message) as Error & { code?: string };
      if (msg.code) err.code = msg.code;
      entry.reject(err);
    }
  }

  /** 仅 reject 某个进程的在途请求（池内其余成员不受影响）。 */
  private failOwn(handle: TtsWorkerHandle, e: Error): void {
    const own: string[] = [];
    this.pending.forEach((entry, id) => {
      if (entry.handle === handle) own.push(id);
    });
    for (const id of own) {
      const entry = this.pending.get(id);
      this.pending.delete(id);
      entry?.reject(e);
    }
  }

  /** 预热：仅 load 模型，不合成（只预热一个成员）。失败非致命。 */
  prewarm(model: TtsModelRequest): void {
    try {
      this.pickWorker().proc.postMessage({ type: 'load', model });
    } catch (e) {
      logMessage(`tts prewarm skipped: ${e}`, 'warning');
    }
  }

  /**
   * 单段合成：text 以 sid（音色序号，voice id 的映射在 catalog 层）与 speed
   * 合成为 16-bit PCM wav 落盘 outWavPath。并发闸由调用方（管线）控制，
   * 池内按在途最少派发。克隆合成（zipvoice）经 generationConfig 携参考对。
   */
  synthesize(req: {
    model: TtsModelRequest;
    text: string;
    sid: number;
    speed?: number;
    outWavPath: string;
    generationConfig?: TtsGenerationConfig;
  }): { id: string; result: Promise<TtsSynthesisResult> } {
    const handle = this.pickWorker();
    const id = `s${++this.seq}`;
    handle.busy += 1;
    const result = new Promise<TtsSynthesisResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, handle });
    });
    handle.proc.postMessage({ type: 'synthesize', id, ...req });
    return { id, result };
  }

  cancel(id: string): void {
    const entry = this.pending.get(id);
    if (entry?.handle.alive) {
      entry.handle.proc.postMessage({ type: 'cancel', id });
    }
  }

  dispose(): void {
    for (const h of this.pool) {
      h.alive = false;
      try {
        h.proc.postMessage({ type: 'dispose' });
        h.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.pool = [];
  }
}

let runtime: SherpaTtsRuntime | null = null;

export function getSherpaTtsRuntime(): SherpaTtsRuntime {
  if (!runtime) runtime = new SherpaTtsRuntime();
  return runtime;
}

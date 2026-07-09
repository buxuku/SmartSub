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

/**
 * 主侧本地 TTS 运行时：常驻一个独立 worker **进程**（Electron utilityProcess）。
 * 与 ASR worker 分进程（退出/重建互不影响）；worker 内 dlopen 原生库、按参数
 * 缓存 OfflineTts 实例。native 层崩溃（onnxruntime abort 等）只死子进程——
 * 在途请求 reject、下次调用自动重建（worker_threads 时代 SIGTRAP 直接带崩
 * 整个应用，2026-07-09 真机事故）。
 * 提供 prewarm / synthesize / cancel / dispose，形制同 sherpaFunasrRuntime。
 */
class SherpaTtsRuntime {
  private worker: UtilityProcess | null = null;
  private seq = 0;
  private pending = new Map<
    string,
    {
      resolve: (r: TtsSynthesisResult) => void;
      reject: (e: Error) => void;
    }
  >();

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker;
    if (!isSherpaLibInstalled()) {
      throw new Error('sherpa native lib not installed');
    }
    const libDir = getSherpaLibDir();
    const w = utilityProcess.fork(workerPath(), [], {
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
    w.on('message', (msg: any) => this.onMessage(msg));
    // native 崩溃前的 stderr 是关键诊断线索（onnxruntime/sherpa 报错都走这里）。
    w.stderr?.on('data', (d: Buffer) => {
      const line = String(d).trim();
      if (line) logMessage(`tts worker stderr: ${line}`, 'warning');
    });
    w.on('exit', (code) => {
      if (code !== 0) {
        this.failAll(
          new Error(
            `本地 TTS 引擎异常退出（code ${code}），已自动重置，请重试`,
          ),
        );
        logMessage(`tts worker exited abnormally (code ${code})`, 'error');
      }
      this.worker = null;
    });
    this.worker = w;
    return w;
  }

  private onMessage(msg: any): void {
    if (msg.type === 'ready') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
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

  private failAll(e: Error): void {
    this.pending.forEach((entry) => entry.reject(e));
    this.pending.clear();
  }

  /** 预热：仅 load 模型，不合成。失败非致命。 */
  prewarm(model: TtsModelRequest): void {
    try {
      this.ensureWorker().postMessage({ type: 'load', model });
    } catch (e) {
      logMessage(`tts prewarm skipped: ${e}`, 'warning');
    }
  }

  /**
   * 单段合成：text 以 sid（音色序号，voice id 的映射在 catalog 层）与 speed
   * 合成为 16-bit PCM wav 落盘 outWavPath。串行队列由调用方（管线并发闸）保证。
   * 克隆合成（zipvoice）经 generationConfig 携参考音频路径与参考文本。
   */
  synthesize(req: {
    model: TtsModelRequest;
    text: string;
    sid: number;
    speed?: number;
    outWavPath: string;
    generationConfig?: TtsGenerationConfig;
  }): { id: string; result: Promise<TtsSynthesisResult> } {
    const w = this.ensureWorker();
    const id = `s${++this.seq}`;
    const result = new Promise<TtsSynthesisResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    w.postMessage({ type: 'synthesize', id, ...req });
    return { id, result };
  }

  cancel(id: string): void {
    this.worker?.postMessage({ type: 'cancel', id });
  }

  dispose(): void {
    this.worker?.postMessage({ type: 'dispose' });
    this.worker?.kill();
    this.worker = null;
  }
}

let runtime: SherpaTtsRuntime | null = null;

export function getSherpaTtsRuntime(): SherpaTtsRuntime {
  if (!runtime) runtime = new SherpaTtsRuntime();
  return runtime;
}

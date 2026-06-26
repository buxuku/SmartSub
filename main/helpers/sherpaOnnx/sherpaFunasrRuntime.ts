import path from 'path';
import { Worker } from 'worker_threads';
import { logMessage } from '../storeManager';
import { getExtraResourcesPath } from '../utils';
import { getSherpaLibDir, isSherpaLibInstalled } from './sherpaLibPaths';
import type { FunasrAddonParams } from '../engines/funasrParams';
import type { QwenAddonParams } from '../engines/qwenParams';
import type { FireRedAddonParams } from '../engines/fireRedParams';

export interface SherpaModelRequest {
  vadModel: string;
  modelType: 'sense_voice' | 'paraformer' | 'qwen3_asr' | 'fire_red_asr';
  /** sense_voice / paraformer：单模型文件 + tokens.txt；fire_red_asr 复用 tokens 承载 tokens.txt。 */
  asrModel?: string;
  tokens?: string;
  /** qwen3_asr：四件套（tokenizer 为目录）。 */
  qwen?: {
    convFrontend: string;
    encoder: string;
    decoder: string;
    tokenizer: string;
  };
  /** fire_red_asr：encoder + decoder 两件套（tokens 走 tokens 字段）。 */
  fireRed?: {
    encoder: string;
    decoder: string;
  };
  /** funasr 用 FunasrAddonParams；qwen 用 QwenAddonParams；fireRed 用 FireRedAddonParams（共享 VAD/线程字段）。 */
  params: FunasrAddonParams | QwenAddonParams | FireRedAddonParams;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** 仅 VAD 边界检测参数（与 transcribe 用的 FunasrAddonParams 的 VAD 字段同名子集）。 */
export interface VadParams {
  vad_threshold: number;
  vad_min_speech_duration_ms: number;
  vad_min_silence_duration_ms: number;
  vad_max_speech_duration_s: number;
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

  /**
   * 仅跑 Silero VAD 取语音段 [{start,end}]（秒），不加载 ASR 识别器。
   * 供内置 whisper.cpp 0-fork 时间轴贴齐（speechBoundary）使用；复用常驻 worker。
   */
  detectSpeech(
    audioFile: string,
    vadModel: string,
    params: VadParams,
  ): {
    id: string;
    result: Promise<{ segments: Array<{ start: number; end: number }> }>;
  } {
    const w = this.ensureWorker();
    const id = `v${++this.seq}`;
    const result = new Promise<{
      segments: Array<{ start: number; end: number }>;
    }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    w.postMessage({ type: 'detectSpeech', id, audioFile, vadModel, params });
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

/**
 * 引擎无关的 sherpa ASR 运行时入口（D4）：funasr 与 qwen 复用同一常驻 worker 与缓存。
 * worker 依 `SherpaModelRequest.modelType` 选择 sense_voice / paraformer / qwen3_asr 分支。
 */
export const getSherpaAsrRuntime = getSherpaFunasrRuntime;

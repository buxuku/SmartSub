import type { ActivityObserver } from '../../../types/taskActivity';
import path from 'path';
import { app } from 'electron';
import { logMessage, store } from '../storeManager';
import { getExtraResourcesPath } from '../utils';
import { getSherpaLibDir, isSherpaLibInstalled } from './sherpaLibPaths';
import { ensureNativeSafeModelPath } from './nativeSafePath';
import {
  NATIVE_STDERR_DRAIN_MS,
  NativeStderrWatch,
  collectNativePaths,
  describeNullVad,
  withNonAsciiPathHint,
  type FailureLanguage,
} from './nativeFailure';
import { spawnAppUtilityHost } from '../crash/appUtilityHost';
import { beginCrashContext } from '../crash/crashContext';
import {
  buildSherpaWorkerEnv,
  describeHostExit,
  type UtilityHost,
} from '../crash/utilityHost';
import type { FunasrAddonParams } from '../engines/funasrParams';
import type { QwenAddonParams } from '../engines/qwenParams';
import type { FireRedAddonParams } from '../engines/fireRedParams';
import type { ParakeetAddonParams } from '../engines/parakeetParams';

export interface SherpaModelRequest {
  vadModel: string;
  modelType:
    | 'sense_voice'
    | 'paraformer'
    | 'qwen3_asr'
    | 'fire_red_asr'
    | 'nemo_transducer'
    | 'nemo_ctc';
  /** sense_voice / paraformer / nemo_ctc：单模型文件 + tokens.txt。 */
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
  /** nemo_transducer：encoder + decoder + joiner 三件套（tokens 走 tokens 字段）。 */
  transducer?: {
    encoder: string;
    decoder: string;
    joiner: string;
  };
  /** 各 sherpa ASR 引擎参数；共同包含 provider、线程和 VAD 字段。 */
  params:
    | FunasrAddonParams
    | QwenAddonParams
    | FireRedAddonParams
    | ParakeetAddonParams;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

interface TranscriptionResult {
  segments: Segment[];
  vadSegments?: Array<{ start: number; end: number }>;
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
 * 随包的小模型（silero VAD / gtcrn 降噪）交给原生库前的路径处理：
 * Windows 上路径含非 ASCII（用户名是中文时默认安装目录就是）时，原生库打不开它，
 * VAD 会静默得到 `vad is nullptr`。此时换成纯 ASCII 目录里的副本（详见 nativeSafePath.ts）。
 */
function nativeSafeModelPath(modelPath: string): string {
  let userDataDir: string | undefined;
  try {
    userDataDir = app.getPath('userData');
  } catch {
    userDataDir = undefined;
  }
  return ensureNativeSafeModelPath(modelPath, {
    userDataDir,
    log: logMessage,
  });
}

function failureLanguage(): FailureLanguage {
  try {
    return store.get('settings')?.language === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

interface PendingRequest {
  resolve: (s: TranscriptionResult) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number) => void;
  onActivity?: ActivityObserver;
  /** 交给原生库的模型路径（VAD 为暂存后的实际路径）：失败时判断是否要提示非 ASCII 路径 */
  nativePaths: string[];
  /**
   * 依赖 VAD 的请求：请求发出时承载它的 worker 及其 stderr 观察者，加上当时 `vad is nullptr`
   * 的累计行数。请求以零结果结束且这个数增长了，说明 VAD 创建失败后在空转（见 nativeFailure.ts）。
   * 观察者随 worker 走，worker 重建不会串到别的请求上。
   */
  vad?: { host: UtilityHost; watch: NativeStderrWatch; mark: number };
}

/**
 * 主侧 sherpa funasr 运行时：常驻一个 worker **进程**（Electron utilityProcess；
 * worker 内 dlopen 原生库、缓存识别器），提供 prewarm / transcribe / cancel /
 * dispose。模型加载与解码均在独立进程，不阻塞主/UI 线程——根治 Windows 首个
 * transcribe 卡 0%；native 层崩溃只死子进程（在途请求 reject、下次自动重建），
 * 不再带崩整个应用。
 */
class SherpaFunasrRuntime {
  private worker: UtilityHost | null = null;
  private seq = 0;
  private pending = new Map<string, PendingRequest>();
  /** 当前 worker 的 stderr 观察者（每个 worker 一个，随 worker 重建） */
  private stderrWatch = new NativeStderrWatch();

  private ensureWorker(): UtilityHost {
    if (this.worker) return this.worker;
    if (!isSherpaLibInstalled()) {
      throw new Error('sherpa native lib not installed');
    }
    // fork / stderr 日志 / 退出分类 / Linux core 限制由共用底座处理（crash/utilityHost.ts）
    const watch = new NativeStderrWatch();
    const w = spawnAppUtilityHost({
      workerFile: workerPath(),
      serviceName: 'smartsub-asr-worker',
      logLabel: 'asr worker',
      env: buildSherpaWorkerEnv(getSherpaLibDir()),
      // 原生库的失败原因只写在 stderr（VAD 甚至不抛错），靠它把静默失败变成明确的错误
      onStderrLine: (line) => watch.push(line),
    });
    this.stderrWatch = watch;
    w.onMessage((msg: any) => this.onMessage(msg));
    w.onExit((info) => {
      // dispose() 先置 this.worker=null 再 kill：此时的非零退出码是信号终止的
      // 垃圾值，属预期停止（模型删除/导入前释放），不按异常处理。
      const expected = this.worker !== w;
      if (expected) {
        this.failAll(new Error('本地转写引擎已释放（模型切换），请重试'));
        return;
      }
      if (info.code !== 0) {
        this.failAll(
          new Error(
            `本地转写引擎异常退出（code ${info.code}），已自动重置，请重试`,
          ),
        );
        logMessage(
          `asr worker exited abnormally (${describeHostExit(info)})`,
          'error',
        );
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
    if (msg.type === 'activity') {
      entry.onActivity?.(msg.detail);
    } else if (msg.type === 'progress') {
      entry.onProgress?.(msg.percent);
    } else if (msg.type === 'done') {
      this.pending.delete(msg.id);
      const result = { segments: msg.segments, vadSegments: msg.vadSegments };
      if (entry.vad && !result.segments?.length) {
        this.settleEmptyResult(entry, entry.vad, result);
      } else {
        entry.resolve(result);
      }
    } else if (msg.type === 'error') {
      this.pending.delete(msg.id);
      const err = new Error(
        withNonAsciiPathHint(msg.message, entry.nativePaths, {
          language: failureLanguage(),
        }),
      ) as Error & { code?: string };
      if (msg.code) err.code = msg.code;
      entry.reject(err);
    }
  }

  /**
   * 零结果可能是真的没有语音，也可能是 VAD 创建失败后的静默空转（构造函数不抛错，之后每次使用
   * 打印 `vad is nullptr`）。后者要变成带原因的错误，否则用户只看到"没有字幕 / 没有采样"。
   * stderr 与结果消息的到达顺序没有保证，所以先等 stderr 排空再判断。
   */
  private settleEmptyResult(
    entry: PendingRequest,
    vad: NonNullable<PendingRequest['vad']>,
    result: TranscriptionResult,
  ): void {
    setTimeout(() => {
      const nullAccesses = vad.watch.nullVadCount - vad.mark;
      if (nullAccesses <= 0) {
        entry.resolve(result);
        return;
      }
      const reasons = vad.watch.nullVadReasons;
      logMessage(
        `sherpa VAD is unusable (${nullAccesses} accesses to a null VAD): ${reasons.join(' | ') || 'no reason captured on stderr'}`,
        'error',
      );
      entry.reject(
        new Error(
          describeNullVad({
            reasons,
            paths: entry.nativePaths,
            language: failureLanguage(),
          }),
        ),
      );
      // worker 里缓存的 VAD 是空句柄，继续复用只会反复静默失败：释放它，下次请求重建。
      // 只释放产生这个结果的那个 worker，不误杀等待期间已经重建的新 worker。
      if (this.worker === vad.host) this.dispose();
    }, NATIVE_STDERR_DRAIN_MS);
  }

  /** 为一个依赖 VAD 的请求记下基线：承载它的 worker、其 stderr 观察者与当前的空 VAD 计数。 */
  private watchVad(host: UtilityHost): NonNullable<PendingRequest['vad']> {
    return {
      host,
      watch: this.stderrWatch,
      mark: this.stderrWatch.nullVadCount,
    };
  }

  private failAll(e: Error): void {
    this.pending.forEach((entry) => entry.reject(e));
    this.pending.clear();
  }

  /** 预热：仅 load 模型，不转写。失败非致命。 */
  prewarm(model: SherpaModelRequest): void {
    try {
      this.ensureWorker().postMessage({
        type: 'load',
        ...model,
        vadModel: nativeSafeModelPath(model.vadModel),
      });
    } catch (e) {
      logMessage(`sherpa prewarm skipped: ${e}`, 'warning');
    }
  }

  transcribe(
    model: SherpaModelRequest,
    audioFile: string,
    onProgress?: (p: number) => void,
    onActivity?: ActivityObserver,
  ): { id: string; result: Promise<TranscriptionResult> } {
    const w = this.ensureWorker();
    // 先处理路径再登记请求：这里抛错不会留下永远不结束的 pending 项
    const vadModel = nativeSafeModelPath(model.vadModel);
    const id = `t${++this.seq}`;
    const nativePaths = collectNativePaths(
      model.asrModel,
      model.tokens,
      model.qwen,
      model.fireRed,
      model.transducer,
      vadModel,
    );
    const result = new Promise<TranscriptionResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        onProgress,
        onActivity,
        nativePaths,
        vad: this.watchVad(w),
      });
    });
    // 崩溃现场：请求结束时移除（then 的两个分支都接住，不派生无人处理的 rejection）
    const endContext = beginCrashContext({
      engine: 'sherpa-asr',
      model: model.modelType,
      phase: 'transcribe',
    });
    result.then(endContext, endContext);
    w.postMessage({
      type: 'transcribe',
      id,
      audioFile,
      ...model,
      vadModel,
    });
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
    const nativeVadModel = nativeSafeModelPath(vadModel);
    const id = `v${++this.seq}`;
    const result = new Promise<{
      segments: Array<{ start: number; end: number }>;
    }>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        nativePaths: [nativeVadModel],
        vad: this.watchVad(w),
      });
    });
    const endContext = beginCrashContext({
      engine: 'sherpa-asr',
      model: vadModel,
      phase: 'detect-speech',
    });
    result.then(endContext, endContext);
    w.postMessage({
      type: 'detectSpeech',
      id,
      audioFile,
      vadModel: nativeVadModel,
      params,
    });
    return { id, result };
  }

  /**
   * 语音降噪（gtcrn 随包模型）：读 wav → 降噪 → 写 wav（输出 16k）。
   * 克隆参考音频的本地降噪可选项；复用常驻 worker（模型 ~500KB 常驻缓存）。
   */
  denoise(
    audioFile: string,
    denoiseModel: string,
    outFile: string,
  ): { id: string; result: Promise<void> } {
    const w = this.ensureWorker();
    const nativeDenoiseModel = nativeSafeModelPath(denoiseModel);
    const id = `d${++this.seq}`;
    const result = new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
        nativePaths: [nativeDenoiseModel],
      });
    });
    const endContext = beginCrashContext({
      engine: 'sherpa-asr',
      model: denoiseModel,
      phase: 'denoise',
    });
    result.then(endContext, endContext);
    w.postMessage({
      type: 'denoise',
      id,
      audioFile,
      denoiseModel: nativeDenoiseModel,
      outFile,
    });
    return { id, result };
  }

  cancel(id: string): void {
    this.worker?.postMessage({ type: 'cancel', id });
  }

  dispose(): void {
    this.worker?.kill();
    this.worker = null;
  }
}

let runtime: SherpaFunasrRuntime | null = null;

export function getSherpaFunasrRuntime(): SherpaFunasrRuntime {
  if (!runtime) runtime = new SherpaFunasrRuntime();
  return runtime;
}

/**
 * 引擎无关的 sherpa ASR 运行时入口（D4）：所有本地 sherpa ASR 复用同一常驻 worker 与缓存。
 * worker 依 `SherpaModelRequest.modelType` 选择具体识别器配置分支。
 */
export const getSherpaAsrRuntime = getSherpaFunasrRuntime;

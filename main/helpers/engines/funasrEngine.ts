import fs from 'fs';
import path from 'path';
import type { EngineStatus, PyEngineManifest } from '../../../types/engine';
import {
  isPyBaseReady,
  isEnginePackageInstalled,
  readEngineManifest,
} from '../pythonRuntime/paths';
import {
  getFunasrModelDir,
  isFunasrReady,
  getInstalledFunasrAsrModels,
  resolveFunasrAsrSelection,
} from '../funasrModelCatalog';
import { formatSrtContent } from '../fileUtils';
import { logMessage, store } from '../storeManager';
import { getPythonRuntimeManager } from '../pythonRuntime';
import { getTaskContext, TaskCancelledError } from '../taskContext';
import { secondsToSrtTime } from './transcribeShared';
import { buildFunasrParams } from './funasrParams';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

let activeFunasrTranscribeId: string | null = null;

type FunasrAsrSelection = NonNullable<
  ReturnType<typeof resolveFunasrAsrSelection>
>;

function cancelFunasrTranscription(): void {
  if (activeFunasrTranscribeId) {
    getPythonRuntimeManager().cancel(activeFunasrTranscribeId);
    activeFunasrTranscribeId = null;
  }
}

/**
 * 组装 sidecar 模型参数（不含 audio_file）。transcribe 与 prewarm(preload) 共用，
 * 确保两者的识别器缓存 key 完全一致（含 language/model_type/线程数等），preload 命中即复用。
 */
function buildFunasrModelParams(
  selection: FunasrAsrSelection,
  settings: Record<string, unknown>,
  sourceLanguage?: string,
): Record<string, unknown> {
  const asrDir = getFunasrModelDir(selection.id);
  return {
    asr_model: path.join(asrDir, 'model.int8.onnx'),
    tokens: path.join(asrDir, 'tokens.txt'),
    vad_model: path.join(getFunasrModelDir('silero-vad'), 'silero_vad.onnx'),
    model_type: selection.modelType,
    ...buildFunasrParams(settings, sourceLanguage),
  };
}

/**
 * 批次预热：在音频抽取的同时，让 sidecar 预加载所选 ASR/VAD 模型。
 * Windows 首次加载原生库 + ONNX（叠加杀软扫描）很慢，若放到首个 transcribe 会出现
 * 「卡在 0% 无进度」的观感。提前 preload 把这部分成本与 ffmpeg 抽取并行掉，且写满
 * 识别器缓存，使首个 transcribe 直接命中。失败一律非致命。
 */
function prewarmFunasr(formData: Record<string, unknown>): void {
  try {
    if (!isFunasrReady()) return;
    const installedAsr = getInstalledFunasrAsrModels();
    const selection = resolveFunasrAsrSelection(
      (formData as { model?: string })?.model,
      installedAsr,
    );
    if (!selection) return;
    const settings = store.get('settings');
    const { sourceLanguage } = formData as { sourceLanguage?: string };
    const params = {
      engine: 'funasr',
      ...buildFunasrModelParams(selection, settings, sourceLanguage),
    };
    const manager = getPythonRuntimeManager();
    if (manager.activeEngineId !== 'funasr' || !manager.isRunning) return;
    // 预加载在 sidecar worker 线程进行，给足冗余超时；method_not_found（旧引擎）等
    // 错误都吞掉——首个 transcribe 仍会按需加载，预热只是优化。
    manager
      .request('preload', params, { timeoutMs: 10 * 60_000 })
      .then(() => logMessage('funasr model prewarm done', 'info'))
      .catch((error) =>
        logMessage(`funasr model prewarm skipped: ${error}`, 'warning'),
      );
    logMessage('funasr model prewarm started', 'info');
  } catch (error) {
    logMessage(`funasr prewarm error (non-fatal): ${error}`, 'warning');
  }
}

function formatInstalledVersion(
  manifest: PyEngineManifest | null,
): string | undefined {
  if (!manifest) return undefined;
  if (manifest.engineVersion) return manifest.engineVersion;
  if (manifest.version && manifest.version !== 'latest')
    return manifest.version;
  if (manifest.sha256) return manifest.sha256.slice(0, 7);
  return undefined;
}

/**
 * 使用 Python sidecar 中的 sherpa-onnx SenseVoice 生成字幕。
 * 取消与 faster-whisper 一致走 AbortSignal：信号触发即通知 sidecar 逐段取消。
 */
async function transcribeFunasr(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  const { tempAudioFile, srtFile } = file;
  const { sourceLanguage } = formData as { sourceLanguage?: string };
  const settings = store.get('settings');

  const manager = getPythonRuntimeManager();
  let engineInfo;
  try {
    engineInfo = await manager.ensureStarted('funasr');
  } catch (error) {
    throw new Error(
      `funasr engine unavailable: ${(error as Error)?.message || error}`,
    );
  }
  if (!engineInfo?.engines?.funasr) {
    throw new Error('funasr is not available in the python engine runtime');
  }
  if (!isFunasrReady()) {
    throw new Error(
      'funasr models not installed. Download SenseVoice + silero-VAD from Resource Hub > Models.',
    );
  }

  const installedAsr = getInstalledFunasrAsrModels();
  const selection = resolveFunasrAsrSelection(
    (formData as { model?: string })?.model,
    installedAsr,
  );
  if (!selection) {
    throw new Error(
      'funasr ASR model not installed. Download SenseVoice or Paraformer from Resource Hub > Models.',
    );
  }

  const params = {
    engine: 'funasr',
    audio_file: tempAudioFile,
    ...buildFunasrModelParams(selection, settings, sourceLanguage),
  };
  logMessage(`funasrParams: ${JSON.stringify(params, null, 2)}`, 'info');
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const { id, result } = manager.transcribe(params, {
    onProgress: (percent) =>
      event.sender.send('taskProgressChange', file, 'extractSubtitle', percent),
  });
  activeFunasrTranscribeId = id;

  const signal = ctx.signal ?? getTaskContext()?.signal;
  const onAbort = () => {
    if (activeFunasrTranscribeId === id) manager.cancel(id);
  };
  if (signal?.aborted) manager.cancel(id);
  else signal?.addEventListener('abort', onAbort, { once: true });

  let transcription;
  try {
    transcription = await result;
  } catch (error) {
    if (signal?.aborted || (error as { code?: string })?.code === 'cancelled') {
      throw new TaskCancelledError();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    activeFunasrTranscribeId = null;
  }

  if (signal?.aborted) throw new TaskCancelledError();

  const formattedSrt = formatSrtContent(
    (transcription?.segments || []).map(
      (segment) =>
        [
          secondsToSrtTime(segment.start),
          secondsToSrtTime(segment.end),
          segment.text || '',
        ] as [string, string, string],
    ),
  );
  await fs.promises.writeFile(srtFile, formattedSrt);

  event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
  logMessage(
    `generate subtitle done (funasr, language=${transcription?.language})`,
    'info',
  );
  return srtFile;
}

export const funasrEngineAdapter: TranscriptionEngineAdapter = {
  id: 'funasr',
  displayName: 'FunASR (SenseVoice / Paraformer)',
  requiresRuntime: true,
  pyEngineId: 'funasr',

  async isAvailable(): Promise<EngineStatus> {
    if (!isPyBaseReady()) {
      return {
        state: 'error',
        message: 'Python base runtime missing; reinstall or update SmartSub',
      };
    }
    if (!isEnginePackageInstalled('funasr')) {
      return {
        state: 'not_installed',
        message: 'funasr engine package not installed',
      };
    }
    // 引擎包在但模型缺：仍报 not_installed（资源中心可下模型），消息区分。
    if (!isFunasrReady()) {
      return {
        state: 'not_installed',
        message: 'funasr models not downloaded',
      };
    }
    const manifest = readEngineManifest('funasr');
    return { state: 'ready', version: formatInstalledVersion(manifest) };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeFunasr(ctx);
  },

  cancelActive(): void {
    cancelFunasrTranscription();
  },

  prewarm(formData: Record<string, unknown>): void {
    prewarmFunasr(formData);
  },
};

import fs from 'fs';
import path from 'path';
import type { EngineStatus } from '../../../types/engine';
import {
  getFunasrModelDir,
  getFunasrVadModelPath,
  isFunasrReady,
  getInstalledFunasrAsrModels,
  resolveFunasrAsrSelection,
} from '../funasrModelCatalog';
import { isSherpaLibInstalled } from '../sherpaOnnx/sherpaLibPaths';
import { getSherpaLibStatus } from '../sherpaOnnx/sherpaLibManager';
import {
  getSherpaFunasrRuntime,
  type SherpaModelRequest,
} from '../sherpaOnnx/sherpaFunasrRuntime';
import { formatSrtContent } from '../fileUtils';
import { logMessage, store } from '../storeManager';
import { getTaskContext, TaskCancelledError } from '../taskContext';
import {
  subtitleCueFromSegment,
  trimSubtitleTrailingSilence,
} from '../subtitleTiming';
import { resplitSubtitleCues } from '../subtitleSegmentation';
import { buildFunasrParams } from './funasrParams';
import { resolveEffectiveSettings } from './outcomePresets';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

/** 在途转写 id 集合：任务级并发下可能同时存在多个（排队+执行），取消须精确到 id。 */
const activeTranscribeIds = new Set<string>();

type FunasrAsrSelection = NonNullable<
  ReturnType<typeof resolveFunasrAsrSelection>
>;

/** 组装 worker 模型请求（不含 audio_file）。transcribe 与 prewarm 共用，缓存 key 一致。 */
function buildModelRequest(
  selection: FunasrAsrSelection,
  settings: Record<string, unknown>,
  sourceLanguage?: string,
): SherpaModelRequest {
  const asrDir = getFunasrModelDir(selection.id);
  return {
    asrModel: path.join(asrDir, 'model.int8.onnx'),
    tokens: path.join(asrDir, 'tokens.txt'),
    vadModel: getFunasrVadModelPath(),
    modelType: selection.modelType,
    params: buildFunasrParams(settings, sourceLanguage),
  };
}

/**
 * 批次预热：在音频抽取的同时，让 worker 预加载所选 ASR/VAD 模型并写满识别器缓存，
 * 使首个 transcribe 直接命中。模型加载在 worker 线程进行，不阻塞主/UI 线程。失败非致命。
 */
function prewarmFunasr(formData: Record<string, unknown>): void {
  try {
    if (!isSherpaLibInstalled() || !isFunasrReady()) return;
    const installedAsr = getInstalledFunasrAsrModels();
    const selection = resolveFunasrAsrSelection(
      (formData as { model?: string })?.model,
      installedAsr,
    );
    if (!selection) return;
    const { sourceLanguage } = formData as { sourceLanguage?: string };
    // 与 transcribe 同源派生 VAD 灵敏度，确保预热与正式转写的 VAD 配置一致。
    const settings = resolveEffectiveSettings(
      formData,
      store.get('settings') as Record<string, unknown>,
    );
    getSherpaFunasrRuntime().prewarm(
      buildModelRequest(selection, settings, sourceLanguage),
    );
    logMessage('funasr (sherpa) prewarm started', 'info');
  } catch (error) {
    logMessage(`funasr prewarm error (non-fatal): ${error}`, 'warning');
  }
}

/**
 * 用 sherpa-onnx Node 原生 addon（worker 线程）生成字幕。
 * 取消与 faster-whisper 一致走 AbortSignal：信号触发即通知 worker 逐段取消。
 */
async function transcribeFunasr(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  const { tempAudioFile, srtFile } = file;
  const { sourceLanguage } = formData as { sourceLanguage?: string };
  // 逐任务运行时派生（字幕效果档位 → VAD 灵敏度），不回写全局。
  const settings = resolveEffectiveSettings(
    formData,
    store.get('settings') as Record<string, unknown>,
  );

  if (!isSherpaLibInstalled()) {
    throw new Error(
      'sherpa runtime not installed. Download it from Resource Hub > Engines.',
    );
  }
  if (!isFunasrReady()) {
    throw new Error(
      'funasr models not installed. Download SenseVoice/Paraformer + silero-VAD from Resource Hub > Models.',
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

  const model = buildModelRequest(selection, settings, sourceLanguage);
  logMessage(`funasr(sherpa) model: ${JSON.stringify(model)}`, 'info');
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const runtime = getSherpaFunasrRuntime();
  const { id, result } = runtime.transcribe(model, tempAudioFile, (percent) =>
    event.sender.send('taskProgressChange', file, 'extractSubtitle', percent),
  );
  activeTranscribeIds.add(id);

  const signal = ctx.signal ?? getTaskContext()?.signal;
  const onAbort = () => {
    if (activeTranscribeIds.has(id)) runtime.cancel(id);
  };
  if (signal?.aborted) runtime.cancel(id);
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
    activeTranscribeIds.delete(id);
  }

  if (signal?.aborted) throw new TaskCancelledError();

  const subtitles = trimSubtitleTrailingSilence(
    resplitSubtitleCues(
      (transcription?.segments || []).map(subtitleCueFromSegment),
      formData as Record<string, unknown>,
    ),
    tempAudioFile,
  );
  const formattedSrt = formatSrtContent(subtitles);
  await fs.promises.writeFile(srtFile, formattedSrt);

  event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
  logMessage('generate subtitle done (funasr/sherpa)', 'info');
  return srtFile;
}

export const funasrEngineAdapter: TranscriptionEngineAdapter = {
  id: 'funasr',
  displayName: 'FunASR (SenseVoice / Paraformer)',
  requiresRuntime: true,

  async isAvailable(): Promise<EngineStatus> {
    if (!isSherpaLibInstalled()) {
      return {
        state: 'not_installed',
        message: 'sherpa runtime not downloaded',
      };
    }
    if (!isFunasrReady()) {
      return {
        state: 'not_installed',
        message: 'funasr models not downloaded',
      };
    }
    return { state: 'ready', version: getSherpaLibStatus().version };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeFunasr(ctx);
  },

  cancelActive(): void {
    const runtime = getSherpaFunasrRuntime();
    activeTranscribeIds.forEach((id) => runtime.cancel(id));
    activeTranscribeIds.clear();
  },

  prewarm(formData: Record<string, unknown>): void {
    prewarmFunasr(formData);
  },
};

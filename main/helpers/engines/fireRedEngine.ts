import fs from 'fs';
import type { EngineStatus } from '../../../types/engine';
import {
  getFireRedModelFiles,
  getFireRedVadModelPath,
  isFireRedReady,
  getInstalledFireRedModels,
  resolveFireRedSelection,
} from '../fireRedModelCatalog';
import { isSherpaLibInstalled } from '../sherpaOnnx/sherpaLibPaths';
import { getSherpaLibStatus } from '../sherpaOnnx/sherpaLibManager';
import {
  getSherpaAsrRuntime,
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
import { buildFireRedParams } from './fireRedParams';
import { resolveEffectiveSettings } from './outcomePresets';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

/** 在途转写 id 集合：任务级并发下可能同时存在多个（排队+执行），取消须精确到 id。 */
const activeTranscribeIds = new Set<string>();

type FireRedSelection = NonNullable<ReturnType<typeof resolveFireRedSelection>>;

/** 组装 worker 模型请求（不含 audio_file）。transcribe 与 prewarm 共用，缓存 key 一致。 */
function buildModelRequest(
  selection: FireRedSelection,
  settings: Record<string, unknown>,
): SherpaModelRequest {
  const files = getFireRedModelFiles(selection.id);
  return {
    modelType: 'fire_red_asr',
    fireRed: { encoder: files.encoder, decoder: files.decoder },
    tokens: files.tokens,
    vadModel: getFireRedVadModelPath(),
    params: buildFireRedParams(settings),
  };
}

/**
 * 批次预热：在音频抽取的同时，让 worker 预加载 FireRedASR 两件套 + 共享 VAD 并写满识别器缓存，
 * 使首个 transcribe 直接命中。模型加载在 worker 线程进行，不阻塞主/UI 线程。失败非致命。
 */
function prewarmFireRed(formData: Record<string, unknown>): void {
  try {
    if (!isSherpaLibInstalled() || !isFireRedReady()) return;
    const selection = resolveFireRedSelection(
      (formData as { model?: string })?.model,
      getInstalledFireRedModels(),
    );
    if (!selection) return;
    // 与 transcribe 同源派生 VAD 灵敏度，确保预热与正式转写的 VAD 配置一致。
    const settings = resolveEffectiveSettings(
      formData,
      store.get('settings') as Record<string, unknown>,
    );
    getSherpaAsrRuntime().prewarm(buildModelRequest(selection, settings));
    logMessage('firered (sherpa) prewarm started', 'info');
  } catch (error) {
    logMessage(`firered prewarm error (non-fatal): ${error}`, 'warning');
  }
}

/**
 * 用 sherpa-onnx Node 原生 addon（worker 线程）跑 FireRedASR-AED 生成字幕。
 * 段级时间戳来自 silero VAD 分段边界（段长安全闸钳到 ≤60s）；取消走 AbortSignal。
 */
async function transcribeFireRed(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  const { tempAudioFile, srtFile } = file;
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
  if (!isFireRedReady()) {
    throw new Error(
      'firered model not installed. Download FireRedASR + silero-VAD from Resource Hub > Models.',
    );
  }

  const selection = resolveFireRedSelection(
    (formData as { model?: string })?.model,
    getInstalledFireRedModels(),
  );
  if (!selection) {
    throw new Error(
      'firered ASR model not installed. Download FireRedASR from Resource Hub > Models.',
    );
  }

  const model = buildModelRequest(selection, settings);
  logMessage(`firered(sherpa) model: ${JSON.stringify(model)}`, 'info');
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const runtime = getSherpaAsrRuntime();
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
  logMessage('generate subtitle done (firered/sherpa)', 'info');
  return srtFile;
}

export const fireRedEngineAdapter: TranscriptionEngineAdapter = {
  id: 'fireRedAsr',
  displayName: 'FireRedASR-AED (L)',
  requiresRuntime: true,

  async isAvailable(): Promise<EngineStatus> {
    if (!isSherpaLibInstalled()) {
      return {
        state: 'not_installed',
        message: 'sherpa runtime not downloaded',
      };
    }
    if (!isFireRedReady()) {
      return {
        state: 'not_installed',
        message: 'firered model not downloaded',
      };
    }
    return { state: 'ready', version: getSherpaLibStatus().version };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeFireRed(ctx);
  },

  cancelActive(): void {
    const runtime = getSherpaAsrRuntime();
    activeTranscribeIds.forEach((id) => runtime.cancel(id));
    activeTranscribeIds.clear();
  },

  prewarm(formData: Record<string, unknown>): void {
    prewarmFireRed(formData);
  },
};

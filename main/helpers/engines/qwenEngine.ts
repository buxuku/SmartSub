import fs from 'fs';
import type { EngineStatus } from '../../../types/engine';
import {
  getQwenModelFiles,
  getQwenVadModelPath,
  isQwenReady,
  getInstalledQwenModels,
  resolveQwenSelection,
} from '../qwenModelCatalog';
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
import { buildQwenParams } from './qwenParams';
import { resolveEffectiveSettings } from './outcomePresets';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

/** 在途转写 id 集合：任务级并发下可能同时存在多个（排队+执行），取消须精确到 id。 */
const activeTranscribeIds = new Set<string>();

type QwenSelection = NonNullable<ReturnType<typeof resolveQwenSelection>>;

/** 组装 worker 模型请求（不含 audio_file）。transcribe 与 prewarm 共用，缓存 key 一致。 */
function buildModelRequest(
  selection: QwenSelection,
  settings: Record<string, unknown>,
): SherpaModelRequest {
  return {
    modelType: 'qwen3_asr',
    qwen: getQwenModelFiles(selection.id),
    vadModel: getQwenVadModelPath(),
    params: buildQwenParams(settings),
  };
}

/**
 * 批次预热：在音频抽取的同时，让 worker 预加载 Qwen 四件套 + 共享 VAD 并写满识别器缓存，
 * 使首个 transcribe 直接命中。模型加载在 worker 线程进行，不阻塞主/UI 线程。失败非致命。
 */
function prewarmQwen(formData: Record<string, unknown>): void {
  try {
    if (!isSherpaLibInstalled() || !isQwenReady()) return;
    const selection = resolveQwenSelection(
      (formData as { model?: string })?.model,
      getInstalledQwenModels(),
    );
    if (!selection) return;
    // 与 transcribe 同源派生 VAD 灵敏度，确保预热与正式转写的 VAD 配置一致。
    const settings = resolveEffectiveSettings(
      formData,
      store.get('settings') as Record<string, unknown>,
    );
    getSherpaAsrRuntime().prewarm(buildModelRequest(selection, settings));
    logMessage('qwen (sherpa) prewarm started', 'info');
  } catch (error) {
    logMessage(`qwen prewarm error (non-fatal): ${error}`, 'warning');
  }
}

/**
 * 用 sherpa-onnx Node 原生 addon（worker 线程）跑 Qwen3-ASR 生成字幕。
 * 段级时间戳来自 silero VAD 分段边界；取消与 faster-whisper 一致走 AbortSignal。
 */
async function transcribeQwen(ctx: TranscribeContext): Promise<string> {
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
  if (!isQwenReady()) {
    throw new Error(
      'qwen model not installed. Download Qwen3-ASR + silero-VAD from Resource Hub > Models.',
    );
  }

  const selection = resolveQwenSelection(
    (formData as { model?: string })?.model,
    getInstalledQwenModels(),
  );
  if (!selection) {
    throw new Error(
      'qwen ASR model not installed. Download Qwen3-ASR from Resource Hub > Models.',
    );
  }

  const model = buildModelRequest(selection, settings);
  logMessage(`qwen(sherpa) model: ${JSON.stringify(model)}`, 'info');
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
  logMessage('generate subtitle done (qwen/sherpa)', 'info');
  return srtFile;
}

export const qwenEngineAdapter: TranscriptionEngineAdapter = {
  id: 'qwen',
  displayName: 'Qwen3-ASR (0.6B)',
  requiresRuntime: true,

  async isAvailable(): Promise<EngineStatus> {
    if (!isSherpaLibInstalled()) {
      return {
        state: 'not_installed',
        message: 'sherpa runtime not downloaded',
      };
    }
    if (!isQwenReady()) {
      return {
        state: 'not_installed',
        message: 'qwen model not downloaded',
      };
    }
    return { state: 'ready', version: getSherpaLibStatus().version };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeQwen(ctx);
  },

  cancelActive(): void {
    const runtime = getSherpaAsrRuntime();
    activeTranscribeIds.forEach((id) => runtime.cancel(id));
    activeTranscribeIds.clear();
  },

  prewarm(formData: Record<string, unknown>): void {
    prewarmQwen(formData);
  },
};

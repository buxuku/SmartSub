import fs from 'fs';
import type { EngineStatus } from '../../../types/engine';
import { getAsrProviderById, getAsrProviders } from '../asrProviderManager';
import {
  getAsrProviderType,
  isAsrProviderConfigured,
  parseAsrModels,
  resolveAudioLimits,
} from '../../../types/asrProvider';
import { getAsrTranscriber } from '../../service/asr';
import type { AsrTranscribeResult } from '../../service/asr/types';
import {
  prepareCloudAudio,
  splitBySilence,
  cleanupCloudChunks,
  CLOUD_MAX_UPLOAD_BYTES,
  CLOUD_MAX_CHUNK_SECONDS,
  type CloudAudioChunk,
} from '../audioProcessor';
import { formatSrtContent } from '../fileUtils';
import { logMessage } from '../storeManager';
import {
  getTaskContext,
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../taskContext';
import { trimSubtitleTrailingSilence } from '../subtitleTiming';
import type { SubtitleCue } from '../subtitleTiming';
import {
  wordCuesFromResult,
  segmentCuesFromSegments,
  singleCueFromText,
  offsetWords,
} from './cloudAsrShared';
import { resplitSubtitleCues } from '../subtitleSegmentation';
import type { AsrWord } from '../../service/asr/types';
import { getCloudProviderGate } from './cloudProviderGate';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

/** 无时间戳（text-only 模型）降级时，用更细的静音切片换取更细的粗粒度时间轴。 */
const COARSE_DEGRADE_CHUNK_SECONDS = 20;
const DEFAULT_CONCURRENCY = 4;

/** 有限并发 map，按序返回结果；worker 内任一失败即整体 reject。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 从若干切片结果统一装配字幕：词级优先，其次段级，最后整段文本（粗粒度）。
 * 任务级 maxSubtitleChars：词级走 composeWordCues（真实词时间断句）；
 * 段级/整段无词时间 → 文本级 resplit 兜底（比例插值）。
 */
function assembleChunkedCues(
  chunks: CloudAudioChunk[],
  results: AsrTranscribeResult[],
  config?: Record<string, unknown>,
): SubtitleCue[] {
  const useWordPath = results.some((r) => (r.words?.length ?? 0) > 0);
  if (useWordPath) {
    const allWords: AsrWord[] = [];
    let allText = '';
    chunks.forEach((chunk, i) => {
      const r = results[i];
      if (r?.words?.length) {
        allWords.push(...offsetWords(r.words, chunk.startOffsetSec));
      }
      if (r?.text) allText += (allText ? ' ' : '') + r.text;
    });
    return wordCuesFromResult({ words: allWords, text: allText }, config);
  }

  const cues: SubtitleCue[] = [];
  chunks.forEach((chunk, i) => {
    const r = results[i];
    if (!r) return;
    if (r.segments?.length) {
      cues.push(...segmentCuesFromSegments(r.segments, chunk.startOffsetSec));
    } else if (r.text) {
      cues.push(
        ...singleCueFromText(r.text, chunk.startOffsetSec, chunk.endOffsetSec),
      );
    }
  });
  return resplitSubtitleCues(cues, config);
}

async function transcribeCloud(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  const { tempAudioFile, srtFile } = file;
  const signal = ctx.signal ?? getTaskContext()?.signal;

  const f = formData as {
    asrProviderId?: string;
    model?: string;
    sourceLanguage?: string;
  };
  const provider = getAsrProviderById(f.asrProviderId);
  if (!provider) {
    throw new Error(
      `Cloud ASR provider not found: ${f.asrProviderId || '(none selected)'}. Configure it in Cloud Transcription settings.`,
    );
  }
  if (!isAsrProviderConfigured(provider)) {
    throw new Error(
      `Cloud ASR provider "${provider.name}" is not fully configured (missing API key / base URL / model).`,
    );
  }
  const transcriber = getAsrTranscriber(provider.type);
  if (!transcriber) {
    throw new Error(`Unknown cloud ASR provider type: ${provider.type}`);
  }

  const models = parseAsrModels(provider);
  const model = String(f.model || models[0] || 'whisper-1');
  const language = f.sourceLanguage ? String(f.sourceLanguage) : undefined;
  const concurrency = Math.max(
    1,
    Math.floor(Number(provider.concurrency) || DEFAULT_CONCURRENCY),
  );
  const intervalMs = Math.max(0, Number(provider.requestInterval) || 0) * 1000;
  // 服务商级全局闸（跨任务共享）：任务级并发放开后，同一服务商的在途请求
  // 总数仍 ≤ concurrency、请求起始间隔 ≥ requestInterval，避免多任务叠加打爆配额。
  const gate = getCloudProviderGate(provider.id);
  gate.setLimits(concurrency, intervalMs);

  logMessage(
    `cloud ASR start: provider=${provider.name} type=${provider.type} model=${model} lang=${language ?? 'auto'}`,
    'info',
  );
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);
  throwIfSignalCancelled(signal);

  let cues: SubtitleCue[] = [];
  // 上传约束：服务商类型声明值优先（如火山 base64 直传需更保守），未声明回落全局默认。
  const limits = resolveAudioLimits(getAsrProviderType(provider.type), {
    maxUploadBytes: CLOUD_MAX_UPLOAD_BYTES,
    maxChunkSeconds: CLOUD_MAX_CHUNK_SECONDS,
  });
  const prepared = await prepareCloudAudio(tempAudioFile, {
    maxBytes: limits.maxUploadBytes,
    signal,
  });

  try {
    if (prepared.sizeBytes > 0 && prepared.sizeBytes <= limits.maxUploadBytes) {
      // 单请求路径：整段上传。整个 transcriber 调用占一个服务商槽
      // （订单制服务商含轮询等待，对应其"并发转写路数"配额）。
      event.sender.send('taskProgressChange', file, 'extractSubtitle', 10);
      const releaseSlot = await gate.acquire(signal);
      let result: AsrTranscribeResult;
      try {
        result = await transcriber(provider, {
          audioPath: prepared.path,
          model,
          language,
          signal,
        });
      } finally {
        releaseSlot();
      }
      throwIfSignalCancelled(signal);

      if (result.hasWordTimestamps) {
        cues = wordCuesFromResult(result, formData as Record<string, unknown>);
      } else if (result.segments?.length) {
        cues = resplitSubtitleCues(
          segmentCuesFromSegments(result.segments, 0),
          formData as Record<string, unknown>,
        );
      } else {
        // 纯文本模型（无词/段时间戳）：按静音细切换取粗粒度时间轴（design 降级路径）。
        logMessage(
          `cloud ASR: model ${model} returned no timestamps, degrading via silence chunking for coarse timing`,
          'warning',
        );
        cues = await transcribeChunkedDegrade(ctx, {
          transcriber,
          provider,
          model,
          language,
          signal,
          concurrency,
          gate,
          chunkSeconds: COARSE_DEGRADE_CHUNK_SECONDS,
        });
      }
    } else {
      // 超限：按静音切片、并发转写、按偏移回拼。
      logMessage(
        `cloud ASR: prepared audio ${(prepared.sizeBytes / 1048576).toFixed(1)}MB exceeds limit, chunking by silence`,
        'info',
      );
      cues = await transcribeChunkedDegrade(ctx, {
        transcriber,
        provider,
        model,
        language,
        signal,
        concurrency,
        gate,
        chunkSeconds: limits.maxChunkSeconds,
      });
    }
  } finally {
    prepared.cleanup();
  }

  throwIfSignalCancelled(signal);
  // 词级/段级路径统一补一次「裁尾」护栏（基于原始 16kHz WAV 能量）。
  const subtitles = trimSubtitleTrailingSilence(cues, tempAudioFile);
  const formattedSrt = formatSrtContent(subtitles);
  await fs.promises.writeFile(srtFile, formattedSrt);

  event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
  logMessage(`cloud ASR: generate subtitle done (${file.fileName})`, 'info');
  return srtFile;
}

interface ChunkTranscribeOptions {
  transcriber: ReturnType<typeof getAsrTranscriber>;
  provider: NonNullable<ReturnType<typeof getAsrProviderById>>;
  model: string;
  language?: string;
  signal?: AbortSignal;
  /** 本任务内的切片 worker 数上限（全局在途总量由 gate 再约束）。 */
  concurrency: number;
  /** 服务商级全局闸（并发 + 速率，跨任务共享）。 */
  gate: ReturnType<typeof getCloudProviderGate>;
  chunkSeconds: number;
}

/** 静音切片 → 并发转写 → 按偏移装配。切片临时文件在结束/失败后清理（不删原始 WAV）。 */
async function transcribeChunkedDegrade(
  ctx: TranscribeContext,
  opts: ChunkTranscribeOptions,
): Promise<SubtitleCue[]> {
  const { event, file } = ctx;
  const { tempAudioFile } = file;
  const chunks = await splitBySilence(tempAudioFile, {
    maxChunkSeconds: opts.chunkSeconds,
    signal: opts.signal,
  });
  let completed = 0;

  try {
    const results = await mapWithConcurrency(
      chunks,
      opts.concurrency,
      async (chunk) => {
        throwIfSignalCancelled(opts.signal);
        const releaseSlot = await opts.gate.acquire(opts.signal);
        let r: AsrTranscribeResult;
        try {
          r = await opts.transcriber!(opts.provider, {
            audioPath: chunk.path,
            model: opts.model,
            language: opts.language,
            signal: opts.signal,
          });
        } finally {
          releaseSlot();
        }
        completed += 1;
        const percent = Math.min(
          99,
          Math.round((completed / chunks.length) * 100),
        );
        event.sender.send(
          'taskProgressChange',
          file,
          'extractSubtitle',
          percent,
        );
        return r;
      },
    );
    return assembleChunkedCues(
      chunks,
      results,
      ctx.formData as Record<string, unknown>,
    );
  } finally {
    cleanupCloudChunks(chunks, tempAudioFile);
  }
}

export const cloudAsrEngineAdapter: TranscriptionEngineAdapter = {
  id: 'cloud',
  displayName: 'Cloud ASR',
  requiresRuntime: false,

  async isAvailable(): Promise<EngineStatus> {
    const providers = getAsrProviders();
    const anyReady = providers.some((p) => isAsrProviderConfigured(p));
    if (!anyReady) {
      return {
        state: 'not_installed',
        message:
          'No cloud ASR provider configured. Add one in Cloud Transcription settings.',
      };
    }
    return { state: 'ready' };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    try {
      return await transcribeCloud(ctx);
    } catch (error) {
      const aborted =
        Boolean(ctx.signal?.aborted) ||
        Boolean(getTaskContext()?.signal?.aborted);
      if (aborted || error instanceof TaskCancelledError) {
        if (ctx.file.srtFile && fs.existsSync(ctx.file.srtFile)) {
          try {
            fs.unlinkSync(ctx.file.srtFile);
          } catch {
            /* ignore partial srt cleanup failure */
          }
        }
        logMessage(`cloud ASR cancelled for ${ctx.file.fileName}`, 'warning');
        throw new TaskCancelledError();
      }
      logMessage(`cloud ASR error: ${error}`, 'error');
      throw error;
    }
  },

  cancelActive(): void {
    // 云引擎经任务 AbortSignal 中断在途 HTTP / ffmpeg（见 transcribe 内 signal 透传），无需额外动作。
  },
};

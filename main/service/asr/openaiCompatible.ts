import fs from 'fs';
import OpenAI from 'openai';
import type { AsrProvider } from '../../../types/asrProvider';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../../helpers/taskContext';
import { logMessage } from '../../helpers/storeManager';
import type { AsrTranscribeInput, AsrTranscribeResult } from './types';
import {
  isVerboseUnsupportedError,
  mapSegments,
  mapWords,
  normalizeBaseURL,
  normalizeLanguage,
  toPositiveNumber,
} from './openaiCompatUtils';

const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MAX_RETRIES = 2;

/**
 * OpenAI 兼容 `audio/transcriptions` 转写。
 *
 * 策略（对齐 spike 验证）：优先 verbose_json + word/segment 时间戳；端点不支持（如
 * gpt-4o-transcribe）自动降级 plain json（仅拿文本，hasWordTimestamps=false，交由上层切片降级）。
 * 显式 timeout（避免 SDK 默认 10 分钟挂起）+ 有限重试（幂等安全）。取消经 AbortSignal 透传。
 */
export async function transcribeWithOpenAiCompatible(
  provider: AsrProvider,
  input: AsrTranscribeInput,
): Promise<AsrTranscribeResult> {
  const apiKey = String(provider?.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('Cloud ASR: API key is required');
  }
  if (!fs.existsSync(input.audioPath)) {
    throw new Error(`Cloud ASR: audio file not found: ${input.audioPath}`);
  }

  const baseURL = normalizeBaseURL(provider.apiUrl);
  const timeoutMs =
    toPositiveNumber(provider.requestTimeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;
  const maxRetries = Math.max(
    0,
    Math.floor(toPositiveNumber(provider.maxRetries, DEFAULT_MAX_RETRIES)),
  );
  const language = normalizeLanguage(input.language);

  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout: timeoutMs,
    maxRetries,
  });

  const callTranscription = async (
    responseFormat: 'verbose_json' | 'json',
    withGranularities: boolean,
  ) => {
    throwIfSignalCancelled(input.signal);
    const params: Record<string, unknown> = {
      file: fs.createReadStream(input.audioPath),
      model: input.model,
      response_format: responseFormat,
    };
    if (language) params.language = language;
    if (withGranularities) {
      params.timestamp_granularities = ['segment', 'word'];
    }
    return client.audio.transcriptions.create(params as never, {
      signal: input.signal,
    });
  };

  try {
    let raw: unknown;
    try {
      raw = await callTranscription('verbose_json', true);
    } catch (error) {
      throwIfSignalCancelled(input.signal);
      if (!isVerboseUnsupportedError(error)) throw error;
      logMessage(
        `Cloud ASR: verbose_json unsupported for model ${input.model}, falling back to plain json (no word timestamps)`,
        'warning',
      );
      raw = await callTranscription('json', false);
    }

    throwIfSignalCancelled(input.signal);
    const obj = (raw ?? {}) as {
      text?: unknown;
      language?: unknown;
      duration?: unknown;
      segments?: unknown;
      words?: unknown;
    };
    const words = mapWords(obj.words);
    const segments = mapSegments(obj.segments);
    return {
      text: String(obj.text ?? ''),
      language: typeof obj.language === 'string' ? obj.language : undefined,
      duration: Number.isFinite(Number(obj.duration))
        ? Number(obj.duration)
        : undefined,
      segments,
      words,
      hasWordTimestamps: words.length > 0,
    };
  } catch (error) {
    if (input.signal?.aborted) throw new TaskCancelledError();
    throw error;
  }
}

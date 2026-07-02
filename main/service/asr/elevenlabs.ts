import fs from 'fs';
import path from 'path';
import type { AsrProvider } from '../../../types/asrProvider';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../../helpers/taskContext';
import { logMessage } from '../../helpers/storeManager';
import type { AsrTranscribeInput, AsrTranscribeResult } from './types';
import { normalizeLanguage, toPositiveNumber } from './openaiCompatUtils';
import {
  buildSpeechToTextURL,
  isRetriableStatus,
  mapElevenLabsWords,
  normalizeElevenLabsBaseURL,
} from './elevenlabsUtils';

const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MAX_RETRIES = 2;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TaskCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TaskCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 单次请求：合并「外部取消 + 超时」到一个 controller；区分「取消」与「超时（可重试）」。 */
async function fetchSpeechToTextOnce(
  url: string,
  apiKey: string,
  form: FormData,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (externalSignal?.aborted) throw new TaskCancelledError();
    if (timedOut) {
      const e = new Error(
        `ElevenLabs STT request timed out after ${timeoutMs}ms`,
      );
      (e as { retriable?: boolean }).retriable = true;
      throw e;
    }
    (error as { retriable?: boolean }).retriable = true;
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function buildForm(
  audioPath: string,
  model: string,
  language?: string,
): FormData {
  const buf = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append('model_id', model);
  form.append(
    'file',
    new Blob([buf as unknown as ArrayBuffer]),
    path.basename(audioPath),
  );
  if (language) form.append('language_code', language);
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  return form;
}

/**
 * ElevenLabs Scribe（`/v1/speech-to-text`）转写。
 *
 * 始终返回词级时间戳（Scribe 模型原生支持），直接喂内置成句管线；无需 verbose 探测/降级。
 * 显式超时 + 有限重试（429/5xx/超时/网络错误）；取消经 AbortSignal 透传，区分「取消 vs 超时」。
 */
export async function transcribeWithElevenLabs(
  provider: AsrProvider,
  input: AsrTranscribeInput,
): Promise<AsrTranscribeResult> {
  const apiKey = String(provider?.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('ElevenLabs ASR: API key is required');
  }
  if (!fs.existsSync(input.audioPath)) {
    throw new Error(`ElevenLabs ASR: audio file not found: ${input.audioPath}`);
  }

  const baseURL = normalizeElevenLabsBaseURL(provider.apiUrl);
  const url = buildSpeechToTextURL(baseURL);
  const timeoutMs =
    toPositiveNumber(provider.requestTimeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;
  const maxRetries = Math.max(
    0,
    Math.floor(toPositiveNumber(provider.maxRetries, DEFAULT_MAX_RETRIES)),
  );
  const language = normalizeLanguage(input.language);

  let attempt = 0;
  for (;;) {
    throwIfSignalCancelled(input.signal);
    try {
      const form = buildForm(input.audioPath, input.model, language);
      const res = await fetchSpeechToTextOnce(
        url,
        apiKey,
        form,
        timeoutMs,
        input.signal,
      );
      if (!res.ok) {
        const status = res.status;
        const bodyText = await res.text().catch(() => '');
        if (isRetriableStatus(status) && attempt < maxRetries) {
          attempt += 1;
          logMessage(
            `ElevenLabs ASR: HTTP ${status}, retry ${attempt}/${maxRetries}`,
            'warning',
          );
          await sleep(500 * 2 ** (attempt - 1), input.signal);
          continue;
        }
        throw new Error(
          `ElevenLabs STT failed: HTTP ${status} ${bodyText.slice(0, 300)}`,
        );
      }
      const data = (await res.json()) as {
        text?: unknown;
        language_code?: unknown;
        words?: unknown;
      };
      const words = mapElevenLabsWords(data?.words);
      return {
        text: String(data?.text ?? ''),
        language:
          typeof data?.language_code === 'string'
            ? data.language_code
            : undefined,
        words,
        hasWordTimestamps: words.length > 0,
      };
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error;
      if (input.signal?.aborted) throw new TaskCancelledError();
      const retriable = (error as { retriable?: boolean })?.retriable === true;
      if (retriable && attempt < maxRetries) {
        attempt += 1;
        logMessage(
          `ElevenLabs ASR: request error, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      throw error;
    }
  }
}

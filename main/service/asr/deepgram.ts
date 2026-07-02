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
  buildListenURL,
  extractDeepgramResult,
  isRetriableStatus,
  normalizeDeepgramBaseURL,
} from './deepgramUtils';

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

/** 按扩展名推断上传 Content-Type（Deepgram 直传二进制体，需正确 mimetype）。 */
function audioContentType(audioPath: string): string {
  const ext = path.extname(audioPath).toLowerCase();
  switch (ext) {
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
    case '.mp4':
      return 'audio/mp4';
    case '.ogg':
    case '.opus':
      return 'audio/ogg';
    case '.flac':
      return 'audio/flac';
    case '.wav':
    default:
      return 'audio/wav';
  }
}

/** 单次请求：合并「外部取消 + 超时」到一个 controller；区分「取消」与「超时（可重试）」。 */
async function postListenOnce(
  url: string,
  apiKey: string,
  body: Buffer,
  contentType: string,
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
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': contentType,
      },
      body: body as unknown as Uint8Array,
      signal: controller.signal,
    });
  } catch (error) {
    if (externalSignal?.aborted) throw new TaskCancelledError();
    if (timedOut) {
      const e = new Error(`Deepgram request timed out after ${timeoutMs}ms`);
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

/**
 * Deepgram（`/v1/listen`）转写。
 *
 * 直传二进制音频体（非 multipart），nova-2/3 原生返回词级时间戳（punctuated_word）→ 直喂内置成句管线。
 * smart_format 开启拿到标点；未指定语言时 detect_language=true 自动识别。
 * 显式超时 + 有限重试（429/5xx/超时/网络）；取消经 AbortSignal 透传，区分「取消 vs 超时」。
 */
export async function transcribeWithDeepgram(
  provider: AsrProvider,
  input: AsrTranscribeInput,
): Promise<AsrTranscribeResult> {
  const apiKey = String(provider?.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('Deepgram ASR: API key is required');
  }
  if (!fs.existsSync(input.audioPath)) {
    throw new Error(`Deepgram ASR: audio file not found: ${input.audioPath}`);
  }

  const baseURL = normalizeDeepgramBaseURL(provider.apiUrl);
  const language = normalizeLanguage(input.language);
  const url = buildListenURL(baseURL, { model: input.model, language });
  const contentType = audioContentType(input.audioPath);
  const timeoutMs =
    toPositiveNumber(provider.requestTimeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;
  const maxRetries = Math.max(
    0,
    Math.floor(toPositiveNumber(provider.maxRetries, DEFAULT_MAX_RETRIES)),
  );

  let attempt = 0;
  for (;;) {
    throwIfSignalCancelled(input.signal);
    try {
      const body = fs.readFileSync(input.audioPath);
      const res = await postListenOnce(
        url,
        apiKey,
        body,
        contentType,
        timeoutMs,
        input.signal,
      );
      if (!res.ok) {
        const status = res.status;
        const bodyText = await res.text().catch(() => '');
        if (isRetriableStatus(status) && attempt < maxRetries) {
          attempt += 1;
          logMessage(
            `Deepgram ASR: HTTP ${status}, retry ${attempt}/${maxRetries}`,
            'warning',
          );
          await sleep(500 * 2 ** (attempt - 1), input.signal);
          continue;
        }
        throw new Error(
          `Deepgram failed: HTTP ${status} ${bodyText.slice(0, 300)}`,
        );
      }
      const data = await res.json();
      const { text, words, language: detected } = extractDeepgramResult(data);
      return {
        text,
        language: detected,
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
          `Deepgram ASR: request error, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      throw error;
    }
  }
}

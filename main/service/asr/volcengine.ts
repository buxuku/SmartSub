import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { AsrProvider } from '../../../types/asrProvider';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../../helpers/taskContext';
import { logMessage } from '../../helpers/storeManager';
import type { AsrTranscribeInput, AsrTranscribeResult } from './types';
import { toPositiveNumber } from './openaiCompatUtils';
import {
  VOLC_FLASH_PATH,
  buildVolcHeaders,
  buildVolcRequestBody,
  classifyVolcStatus,
  extractVolcResult,
  normalizeVolcBaseURL,
} from './volcengineUtils';

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
async function postFlashOnce(
  url: string,
  headers: Record<string, string>,
  body: string,
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
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (externalSignal?.aborted) throw new TaskCancelledError();
    if (timedOut) {
      const e = new Error(`Volcengine request timed out after ${timeoutMs}ms`);
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
 * 火山引擎豆包「大模型录音文件识别·极速版」转写。
 *
 * 鉴权：新版语音控制台 API Key（单 X-Api-Key）。
 * base64 直传（audio.data，非 URL——音频不出本机存储），单请求同步返回；
 * show_utterances 开启后原生返回分句 + 逐字时间戳（毫秒）→ 词级喂内置成句管线，
 * 逐字无标点由引擎侧 realignPunctuation 从整段文本回贴。
 * 成败以响应头 X-Api-Status-Code 判定（HTTP 可能恒 200）：静音音频按空结果成功；
 * 参数/鉴权类不重试；过载/服务内部错/429/5xx/网络/超时按指数退避有限重试。
 */
export async function transcribeWithVolcengine(
  provider: AsrProvider,
  input: AsrTranscribeInput,
): Promise<AsrTranscribeResult> {
  const apiKey = String(provider?.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('Volcengine ASR: API Key is required');
  }
  if (!fs.existsSync(input.audioPath)) {
    throw new Error(`Volcengine ASR: audio file not found: ${input.audioPath}`);
  }

  const baseURL = normalizeVolcBaseURL(provider.apiUrl);
  const url = `${baseURL}${VOLC_FLASH_PATH}`;
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
      const base64 = fs.readFileSync(input.audioPath).toString('base64');
      const body = JSON.stringify(buildVolcRequestBody(base64, input.model));
      const res = await postFlashOnce(
        url,
        buildVolcHeaders(apiKey, uuidv4()),
        body,
        timeoutMs,
        input.signal,
      );
      const statusCode = res.headers.get('X-Api-Status-Code');
      const statusMessage = res.headers.get('X-Api-Message') ?? '';
      const cls = classifyVolcStatus(res.status, statusCode);

      if (cls === 'success') {
        const data = await res.json();
        const { text, words, segments } = extractVolcResult(data);
        return {
          text,
          segments,
          words,
          hasWordTimestamps: words.length > 0,
        };
      }
      if (cls === 'empty') {
        // 静音音频（20000003）：按空结果成功，与本地引擎「无人声→空字幕」语义一致。
        logMessage(
          `Volcengine ASR: silent audio (code ${statusCode}), returning empty result`,
          'warning',
        );
        return { text: '', segments: [], words: [], hasWordTimestamps: false };
      }
      if (cls === 'retriable' && attempt < maxRetries) {
        attempt += 1;
        logMessage(
          `Volcengine ASR: HTTP ${res.status} code ${statusCode ?? '(none)'}, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      const bodyText = await res.text().catch(() => '');
      const reason = statusMessage || bodyText.slice(0, 300);
      if (cls === 'auth') {
        throw new Error(
          `Volcengine ASR auth failed: HTTP ${res.status} ${reason}`.trim(),
        );
      }
      throw new Error(
        `Volcengine ASR failed: HTTP ${res.status} code ${statusCode ?? '(none)'} ${reason}`.trim(),
      );
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error;
      if (input.signal?.aborted) throw new TaskCancelledError();
      const retriable = (error as { retriable?: boolean })?.retriable === true;
      if (retriable && attempt < maxRetries) {
        attempt += 1;
        logMessage(
          `Volcengine ASR: request error, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      throw error;
    }
  }
}

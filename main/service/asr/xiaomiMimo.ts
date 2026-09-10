import fs from 'fs';
import type { AsrProvider } from '../../../types/asrProvider';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
  waitForTaskDelay,
} from '../../helpers/taskContext';
import {
  buildXiaomiMimoHeaders,
  positiveNumber,
  readXiaomiMimoError,
  xiaomiMimoChatURL,
} from '../xiaomiMimoUtils';
import type { AsrTranscribeInput, AsrTranscribeResult } from './types';
import {
  buildXiaomiMimoAsrBody,
  isRetryableXiaomiMimoAsrStatus,
  parseXiaomiMimoAsrResponse,
  xiaomiMimoAudioFormat,
} from './xiaomiMimoUtils';

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_RETRIES = 2;

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(10_000, retryAfterSeconds * 1000);
  }
  return 500 * 2 ** attempt;
}

export async function transcribeWithXiaomiMimo(
  provider: AsrProvider,
  input: AsrTranscribeInput,
): Promise<AsrTranscribeResult> {
  const apiKey = String(provider.apiKey ?? '').trim();
  if (!apiKey) throw new Error('Xiaomi MiMo ASR: API key is required');
  if (!fs.existsSync(input.audioPath)) {
    throw new Error(
      `Xiaomi MiMo ASR: audio file not found: ${input.audioPath}`,
    );
  }

  const body = buildXiaomiMimoAsrBody({
    data: fs.readFileSync(input.audioPath).toString('base64'),
    format: xiaomiMimoAudioFormat(input.audioPath),
    language: input.language,
  });
  const timeoutMs =
    positiveNumber(provider.requestTimeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;
  const requestUrl = xiaomiMimoChatURL(provider.apiUrl);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    throwIfSignalCancelled(input.signal);
    let res: Response;
    try {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (input.signal) signals.push(input.signal);
      res = await fetch(requestUrl, {
        method: 'POST',
        headers: buildXiaomiMimoHeaders(apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (input.signal?.aborted) throw new TaskCancelledError();
      if (attempt < MAX_RETRIES) {
        await waitForTaskDelay(retryDelayMs(attempt, null), input.signal);
        continue;
      }
      throw error;
    }

    if (!res.ok) {
      if (attempt < MAX_RETRIES && isRetryableXiaomiMimoAsrStatus(res.status)) {
        await waitForTaskDelay(
          retryDelayMs(attempt, res.headers.get('Retry-After')),
          input.signal,
        );
        continue;
      }
      const detail = await readXiaomiMimoError(res);
      throw new Error(
        `Xiaomi MiMo ASR: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`,
      );
    }
    const parsed = parseXiaomiMimoAsrResponse(await res.json());
    return {
      ...parsed,
      segments: [],
      words: [],
      hasWordTimestamps: false,
    };
  }
  throw new Error('Xiaomi MiMo ASR: request failed after retries');
}

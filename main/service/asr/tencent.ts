import fs from 'fs';
import type { AsrProvider } from '../../../types/asrProvider';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../../helpers/taskContext';
import { logMessage } from '../../helpers/storeManager';
import type { AsrTranscribeInput, AsrTranscribeResult } from './types';
import { toPositiveNumber } from './openaiCompatUtils';
import {
  TENCENT_ASR_HOST,
  TENCENT_FLASH_PATH,
  buildTencentParams,
  buildTencentQuery,
  classifyTencentCode,
  extractTencentResult,
  resolveTencentEngineType,
  signTencentRequest,
  voiceFormatFromPath,
} from './tencentUtils';

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
  authorization: string,
  body: Buffer,
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
        // 裸签名值，无 Bearer/前缀（签名 v1 约定）。
        Authorization: authorization,
        'Content-Type': 'application/octet-stream',
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (externalSignal?.aborted) throw new TaskCancelledError();
    if (timedOut) {
      const e = new Error(`Tencent ASR request timed out after ${timeoutMs}ms`);
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
 * 腾讯云「录音文件识别极速版」转写。
 *
 * 鉴权：签名 v1（AppID + SecretID + SecretKey，HMAC-SHA1）；音频原始二进制直传
 * （application/octet-stream，无 base64 膨胀），单请求同步返回。
 * `engine_type` 由「任务所选模型档位（standard/large）+ 任务原语言」映射
 * （resolveTencentEngineType）；语言不支持时上传前即报错——继续上传只会产出
 * 乱码还照常计费。历史存量的原始 engine_type（16k_*）原样透传。
 * 每次尝试（含重试）重取 timestamp 重签——服务端校验 ±3 分钟时效，
 * 沿用旧签名在长退避后会假失败（design D2）。
 * word_info=1 返回逐词时间戳（词无标点），标点由引擎侧从整段文本回贴；
 * 空文本（如静音）按空结果成功，与本地引擎「无人声→空字幕」语义一致。
 */
export async function transcribeWithTencent(
  provider: AsrProvider,
  input: AsrTranscribeInput,
): Promise<AsrTranscribeResult> {
  const appid = String(provider?.appid ?? '').trim();
  const secretId = String(provider?.secretId ?? '').trim();
  const secretKey = String(provider?.secretKey ?? '').trim();
  if (!appid || !secretId || !secretKey) {
    throw new Error('Tencent ASR: AppID / SecretID / SecretKey are required');
  }
  if (!fs.existsSync(input.audioPath)) {
    throw new Error(`Tencent ASR: audio file not found: ${input.audioPath}`);
  }

  const engineType = resolveTencentEngineType(input.model, input.language);
  if (!engineType) {
    throw new Error(
      `Tencent ASR: source language "${input.language}" is not supported by Tencent flash recognition`,
    );
  }
  const voiceFormat = voiceFormatFromPath(input.audioPath);
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
      const query = buildTencentQuery(
        buildTencentParams({
          secretId,
          engineType,
          voiceFormat,
          timestamp: Math.floor(Date.now() / 1000),
        }),
      );
      const url = `https://${TENCENT_ASR_HOST}${TENCENT_FLASH_PATH}${appid}?${query}`;
      const authorization = signTencentRequest(secretKey, appid, query);
      const audio = fs.readFileSync(input.audioPath);
      const res = await postFlashOnce(
        url,
        authorization,
        audio,
        timeoutMs,
        input.signal,
      );

      const bodyText = await res.text().catch(() => '');
      let data: unknown;
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = undefined;
      }
      const code = (data as { code?: unknown })?.code;
      const message = String((data as { message?: unknown })?.message ?? '');
      const cls = classifyTencentCode(
        res.status,
        typeof code === 'number' || typeof code === 'string' ? code : null,
      );

      if (cls === 'success') {
        const { text, words, segments } = extractTencentResult(data);
        if (!text.trim()) {
          // code 0 + 空文本（如静音音频）：按空结果成功。
          logMessage(
            'Tencent ASR: empty transcription (silent audio?), returning empty result',
            'warning',
          );
          return {
            text: '',
            segments: [],
            words: [],
            hasWordTimestamps: false,
          };
        }
        return {
          text,
          segments,
          words,
          hasWordTimestamps: words.length > 0,
        };
      }
      if (cls === 'retriable' && attempt < maxRetries) {
        attempt += 1;
        logMessage(
          `Tencent ASR: HTTP ${res.status} code ${code ?? '(none)'} ${message}, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      const reason = message || bodyText.slice(0, 300);
      if (cls === 'auth') {
        throw new Error(
          `Tencent ASR auth failed (code 4002): ${reason}`.trim(),
        );
      }
      throw new Error(
        `Tencent ASR failed: HTTP ${res.status} code ${code ?? '(none)'} ${reason}`.trim(),
      );
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error;
      if (input.signal?.aborted) throw new TaskCancelledError();
      const retriable = (error as { retriable?: boolean })?.retriable === true;
      if (retriable && attempt < maxRetries) {
        attempt += 1;
        logMessage(
          `Tencent ASR: request error, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      throw error;
    }
  }
}

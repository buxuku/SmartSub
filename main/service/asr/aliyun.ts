import fs from 'fs';
import { randomUUID } from 'crypto';
import type { AsrProvider } from '../../../types/asrProvider';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../../helpers/taskContext';
import { logMessage } from '../../helpers/storeManager';
import type { AsrTranscribeInput, AsrTranscribeResult } from './types';
import { toPositiveNumber } from './openaiCompatUtils';
import { voiceFormatFromPath } from './tencentUtils';
import {
  ALIYUN_FLASH_PATH,
  ALIYUN_META_HOST,
  ALIYUN_NLS_GATEWAY_HOST,
  buildCreateTokenQuery,
  buildFlashQuery,
  classifyAliyunStatus,
  extractAliyunResult,
  isTokenExpired,
  percentEncodeRfc3986,
  signCreateToken,
} from './aliyunUtils';

const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MAX_RETRIES = 2;
const TOKEN_TIMEOUT_MS = 15000;

/**
 * Token 进程内缓存：按 AccessKeyId 键控（CreateToken 与 appkey 无关——同一账号
 * 多实例/多 appkey 共享一枚；ExpireTime 为秒级绝对时间戳，实测有效期 ≈36h）。
 * 官方 FAQ 明示 Token 可复用、重取不影响已发 Token——多切片并发首次同时 miss
 * 会重复取号 1-2 次，无害不加锁（design D2）。
 */
const tokenCache = new Map<string, { token: string; expireTime: number }>();

/** 仅测试/诊断用：清空 Token 缓存。 */
export function clearAliyunTokenCache(): void {
  tokenCache.clear();
}

/**
 * 取可用 Token：缓存命中且未临期直取；否则调 CreateToken（POP 签名）并回填缓存。
 * `force` 强制刷新（识别请求报 Token 失效类错误时清缓存重取）。
 * 导出供 testConnection 复用（探测第一段：验 AccessKey）。
 */
export async function getAliyunToken(
  accessKeyId: string,
  accessKeySecret: string,
  force = false,
): Promise<string> {
  const cached = tokenCache.get(accessKeyId);
  if (!force && cached && !isTokenExpired(cached.expireTime, Date.now())) {
    return cached.token;
  }
  tokenCache.delete(accessKeyId);

  const timestampIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const query = buildCreateTokenQuery(accessKeyId, randomUUID(), timestampIso);
  const signature = signCreateToken(accessKeySecret, query);
  const url = `https://${ALIYUN_META_HOST}/?Signature=${percentEncodeRfc3986(signature)}&${query}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const bodyText = await res.text().catch(() => '');
  let data:
    | {
        Token?: { Id?: unknown; ExpireTime?: unknown };
        Code?: unknown;
        Message?: unknown;
      }
    | undefined;
  try {
    data = JSON.parse(bodyText);
  } catch {
    data = undefined;
  }
  const token = String(data?.Token?.Id ?? '').trim();
  if (!res.ok || !token) {
    const code = String(data?.Code ?? '').trim();
    const message =
      String(data?.Message ?? '').trim() || bodyText.slice(0, 300);
    throw new Error(
      `Aliyun ASR CreateToken failed: HTTP ${res.status}${code ? ` ${code}` : ''} ${message}`.trim(),
    );
  }
  const expireTime = Number(data?.Token?.ExpireTime);
  tokenCache.set(accessKeyId, {
    token,
    expireTime: Number.isFinite(expireTime) ? expireTime : 0,
  });
  return token;
}

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

/** 单次识别请求：合并「外部取消 + 超时」；区分「取消」与「超时（可重试）」。 */
async function postFlashOnce(
  url: string,
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
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (externalSignal?.aborted) throw new TaskCancelledError();
    if (timedOut) {
      const e = new Error(`Aliyun ASR request timed out after ${timeoutMs}ms`);
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
 * 阿里云 NLS「录音文件识别极速版」转写。
 *
 * 两段式鉴权：AccessKey 经 CreateToken（POP 签名）取临时 Token（进程内缓存，
 * ExpireTime 驱动），识别以 `appkey + token` URL 参数鉴权；音频原始二进制直传
 * （application/octet-stream），单请求同步返回。识别语种绑定 appkey 对应的
 * NLS 控制台项目（请求无语言参数）——`input.language` 对本服务商不生效。
 * Token 失效类错误（40000001/403）清缓存强刷后原地重试一次（不计入退避次数）；
 * `40270002`（无有效语音，如静音切片）按空结果成功，与本地引擎语义一致。
 */
export async function transcribeWithAliyun(
  provider: AsrProvider,
  input: AsrTranscribeInput,
): Promise<AsrTranscribeResult> {
  const accessKeyId = String(provider?.accessKeyId ?? '').trim();
  const accessKeySecret = String(provider?.accessKeySecret ?? '').trim();
  const appkey = String(provider?.appkey ?? '').trim();
  if (!accessKeyId || !accessKeySecret || !appkey) {
    throw new Error(
      'Aliyun ASR: AccessKey ID / AccessKey Secret / Appkey are required',
    );
  }
  if (!fs.existsSync(input.audioPath)) {
    throw new Error(`Aliyun ASR: audio file not found: ${input.audioPath}`);
  }

  const format = voiceFormatFromPath(input.audioPath);
  const timeoutMs =
    toPositiveNumber(provider.requestTimeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;
  const maxRetries = Math.max(
    0,
    Math.floor(toPositiveNumber(provider.maxRetries, DEFAULT_MAX_RETRIES)),
  );

  let attempt = 0;
  let authRetried = false;
  for (;;) {
    throwIfSignalCancelled(input.signal);
    try {
      const token = await getAliyunToken(accessKeyId, accessKeySecret);
      const query = buildFlashQuery({ appkey, token, format });
      const url = `https://${ALIYUN_NLS_GATEWAY_HOST}${ALIYUN_FLASH_PATH}?${query}`;
      const audio = fs.readFileSync(input.audioPath);
      const res = await postFlashOnce(url, audio, timeoutMs, input.signal);

      const bodyText = await res.text().catch(() => '');
      let data: unknown;
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = undefined;
      }
      const status = (data as { status?: unknown })?.status;
      const message = String((data as { message?: unknown })?.message ?? '');
      const cls = classifyAliyunStatus(
        res.status,
        typeof status === 'number' || typeof status === 'string'
          ? status
          : null,
      );

      if (cls === 'success' || cls === 'empty') {
        if (cls === 'empty') {
          // 40270002 vad silent：无有效语音（如静音切片）→ 空结果成功。
          logMessage(
            'Aliyun ASR: no valid speech (silent audio?), returning empty result',
            'warning',
          );
          return {
            text: '',
            segments: [],
            words: [],
            hasWordTimestamps: false,
          };
        }
        const { text, words, segments } = extractAliyunResult(data);
        if (!text.trim()) {
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
      if (cls === 'auth' && !authRetried) {
        // Token 失效类（40000001/403）：清缓存强刷后原地重试一次，不计入退避次数。
        authRetried = true;
        logMessage(
          `Aliyun ASR: token rejected (status ${status ?? res.status}), refreshing token and retrying`,
          'warning',
        );
        await getAliyunToken(accessKeyId, accessKeySecret, true);
        continue;
      }
      if (cls === 'retriable' && attempt < maxRetries) {
        attempt += 1;
        logMessage(
          `Aliyun ASR: HTTP ${res.status} status ${status ?? '(none)'} ${message}, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      const reason = message || bodyText.slice(0, 300);
      if (cls === 'auth') {
        throw new Error(`Aliyun ASR auth failed: ${reason}`.trim());
      }
      throw new Error(
        `Aliyun ASR failed: HTTP ${res.status} status ${status ?? '(none)'} ${reason}`.trim(),
      );
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error;
      if (input.signal?.aborted) throw new TaskCancelledError();
      const retriable = (error as { retriable?: boolean })?.retriable === true;
      if (retriable && attempt < maxRetries) {
        attempt += 1;
        logMessage(
          `Aliyun ASR: request error, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), input.signal);
        continue;
      }
      throw error;
    }
  }
}

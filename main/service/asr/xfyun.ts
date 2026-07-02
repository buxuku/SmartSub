import fs from 'fs';
import crypto from 'crypto';
import type { AsrProvider } from '../../../types/asrProvider';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../../helpers/taskContext';
import { logMessage, store } from '../../helpers/storeManager';
import type { AsrTranscribeInput, AsrTranscribeResult } from './types';
import { toPositiveNumber } from './openaiCompatUtils';
import {
  XFYUN_API_HOST,
  XFYUN_GET_RESULT_PATH,
  XFYUN_UPLOAD_PATH,
  buildXfyunDateTime,
  buildXfyunQuery,
  buildXfyunRandom,
  classifyXfyunCode,
  extractXfyunResult,
  isXfyunOrderGone,
  mapXfyunFailType,
  normalizeXfyunTier,
  resolveXfyunLanguageSupport,
  signXfyunRequest,
  xfyunFileNameFromPath,
} from './xfyunUtils';

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MAX_RETRIES = 2;

/** 轮询间隔梯度：先密后疏（毫秒）。 */
const POLL_INTERVALS_MS: Array<{ intervalMs: number; times: number }> = [
  { intervalMs: 5_000, times: 6 },
  { intervalMs: 10_000, times: 12 },
  { intervalMs: 45_000, times: Number.POSITIVE_INFINITY },
];
/** 官方 getResult ≤100 次/订单，留余量。 */
const POLL_MAX_QUERIES = 96;
/** 轮询总等待上限（自轮询起算）；到点保留持久化记录、重跑任务续查。 */
const POLL_MAX_WAIT_MS = 62 * 60 * 1000;
/** 单次查询失败（网络/超时/可重试码）连续达此次数判死。 */
const POLL_MAX_CONSECUTIVE_FAILURES = 5;

/** 跨会话续查记录有效期：保守于服务端结果保留期（实测 expireTime ≈ 创建 +5 天）。 */
const PENDING_ORDER_TTL_MS = 72 * 60 * 60 * 1000;
const PENDING_ORDERS_KEY = 'xfyunPendingOrders';

interface XfyunPendingOrder {
  orderId: string;
  /** getResult 必须与 upload 复用同一随机串（官方要求，实测确认），故随单持久化。 */
  signatureRandom: string;
  createdAt: number;
}

/** 读全表并惰性清理过期记录（写回仅在有变化时）。 */
function readPendingOrders(): Record<string, XfyunPendingOrder> {
  const raw = store.get(PENDING_ORDERS_KEY) as
    | Record<string, XfyunPendingOrder>
    | undefined;
  if (!raw || typeof raw !== 'object') return {};
  const now = Date.now();
  const alive: Record<string, XfyunPendingOrder> = {};
  let dropped = 0;
  for (const [key, rec] of Object.entries(raw)) {
    if (
      rec &&
      typeof rec.orderId === 'string' &&
      typeof rec.signatureRandom === 'string' &&
      Number.isFinite(rec.createdAt) &&
      now - rec.createdAt < PENDING_ORDER_TTL_MS
    ) {
      alive[key] = rec;
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) store.set(PENDING_ORDERS_KEY, alive);
  return alive;
}

function savePendingOrder(key: string, record: XfyunPendingOrder): void {
  const all = readPendingOrders();
  all[key] = record;
  store.set(PENDING_ORDERS_KEY, all);
}

function deletePendingOrder(key: string): void {
  const all = readPendingOrders();
  if (key in all) {
    delete all[key];
    store.set(PENDING_ORDERS_KEY, all);
  }
}

/** 续查指纹：压缩音频内容 hash + 服务商实例 + 档位（临时文件路径每次重跑都变，不可用）。 */
function pendingOrderKey(
  audio: Buffer,
  providerId: string,
  tier: string,
): string {
  const hash = crypto.createHash('sha1').update(audio).digest('hex');
  return `${hash}:${providerId}:${tier}`;
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

/** 单次请求：合并「外部取消 + 超时」到一个 controller；区分「取消」与「超时（可重试）」。 */
async function postXfyunOnce(
  url: string,
  headers: Record<string, string>,
  body: Buffer | string,
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
      const e = new Error(`Xfyun ASR request timed out after ${timeoutMs}ms`);
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

interface XfyunCredentials {
  appid: string;
  apiKey: string;
  apiSecret: string;
}

/** 每次调用现签（dateTime 时效 ±，code 100008），返回完整 URL 与 signature 头。 */
function buildSignedUrl(
  path: string,
  creds: XfyunCredentials,
  extraParams: Record<string, string | undefined>,
): { url: string; signature: string } {
  const query = buildXfyunQuery({
    appId: creds.appid,
    accessKeyId: creds.apiKey,
    dateTime: buildXfyunDateTime(),
    ...extraParams,
  });
  return {
    url: `https://${XFYUN_API_HOST}${path}?${query}`,
    signature: signXfyunRequest(creds.apiSecret, query),
  };
}

interface XfyunUploadOutcome {
  orderId: string;
  taskEstimateTimeMs: number;
}

/** 上传创建订单（指数退避有限重试；每次尝试重取 dateTime 重签）。 */
async function uploadOrder(options: {
  creds: XfyunCredentials;
  audio: Buffer;
  audioPath: string;
  tier: string;
  signatureRandom: string;
  timeoutMs: number;
  maxRetries: number;
  signal?: AbortSignal;
}): Promise<XfyunUploadOutcome> {
  const {
    creds,
    audio,
    audioPath,
    tier,
    signatureRandom,
    timeoutMs,
    maxRetries,
    signal,
  } = options;
  let attempt = 0;
  for (;;) {
    throwIfSignalCancelled(signal);
    try {
      const { url, signature } = buildSignedUrl(XFYUN_UPLOAD_PATH, creds, {
        signatureRandom,
        fileName: xfyunFileNameFromPath(audioPath),
        fileSize: String(audio.length),
        // 关闭服务端时长校验：免 ffprobe 取时长依赖，消除 failType=5 整类错误。
        durationCheckDisable: 'true',
        language: tier,
      });
      const res = await postXfyunOnce(
        url,
        { 'Content-Type': 'application/octet-stream', signature },
        audio,
        timeoutMs,
        signal,
      );
      const bodyText = await res.text().catch(() => '');
      let data: { code?: unknown; descInfo?: unknown; content?: unknown };
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = {};
      }
      const code = data?.code as string | number | undefined;
      const cls = classifyXfyunCode(res.status, code ?? null);
      if (cls === 'success') {
        const content = data?.content as
          | { orderId?: unknown; taskEstimateTime?: unknown }
          | undefined;
        const orderId = String(content?.orderId ?? '').trim();
        if (!orderId) {
          throw new Error('Xfyun ASR upload succeeded but no orderId returned');
        }
        return {
          orderId,
          taskEstimateTimeMs: Number(content?.taskEstimateTime) || 0,
        };
      }
      const reason = String(data?.descInfo ?? '') || bodyText.slice(0, 300);
      if (cls === 'retriable' && attempt < maxRetries) {
        attempt += 1;
        logMessage(
          `Xfyun ASR upload: HTTP ${res.status} code ${code ?? '(none)'} ${reason}, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), signal);
        continue;
      }
      if (cls === 'auth') {
        throw new Error(
          `Xfyun ASR auth failed (code ${code}): ${reason} — check APPID / APIKey / APISecret and system clock`.trim(),
        );
      }
      throw new Error(
        `Xfyun ASR upload failed: HTTP ${res.status} code ${code ?? '(none)'} ${reason}`.trim(),
      );
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error;
      if (signal?.aborted) throw new TaskCancelledError();
      const retriable = (error as { retriable?: boolean })?.retriable === true;
      if (retriable && attempt < maxRetries) {
        attempt += 1;
        logMessage(
          `Xfyun ASR upload: request error, retry ${attempt}/${maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), signal);
        continue;
      }
      throw error;
    }
  }
}

type XfyunPollOutcome =
  | { kind: 'done'; result: AsrTranscribeResult }
  | { kind: 'order-gone' };

/** 按梯度间隔取下一次轮询等待时长。 */
function pollIntervalMs(queryIndex: number): number {
  let remaining = queryIndex;
  for (const { intervalMs, times } of POLL_INTERVALS_MS) {
    if (remaining < times) return intervalMs;
    remaining -= times;
  }
  return POLL_INTERVALS_MS[POLL_INTERVALS_MS.length - 1].intervalMs;
}

/**
 * 轮询订单直至完成/失败/失效/超限。
 * 单次查询失败不中止订单（连续 POLL_MAX_CONSECUTIVE_FAILURES 次判死）；
 * auth/fatal 码立即抛错；订单不存在/非法返回 order-gone 交调用方语义化。
 */
async function pollOrder(options: {
  creds: XfyunCredentials;
  orderId: string;
  signatureRandom: string;
  firstDelayMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<XfyunPollOutcome> {
  const { creds, orderId, signatureRandom, firstDelayMs, timeoutMs, signal } =
    options;
  const startedAt = Date.now();
  let consecutiveFailures = 0;

  await sleep(firstDelayMs, signal);
  for (let query = 0; query < POLL_MAX_QUERIES; query += 1) {
    throwIfSignalCancelled(signal);
    if (Date.now() - startedAt > POLL_MAX_WAIT_MS) break;

    let handled = false;
    try {
      const { url, signature } = buildSignedUrl(XFYUN_GET_RESULT_PATH, creds, {
        signatureRandom,
        orderId,
        resultType: 'transfer',
      });
      const res = await postXfyunOnce(
        url,
        { 'Content-Type': 'application/json', signature },
        '{}',
        timeoutMs,
        signal,
      );
      const bodyText = await res.text().catch(() => '');
      let data:
        | {
            code?: unknown;
            descInfo?: unknown;
            content?: {
              orderInfo?: { status?: unknown; failType?: unknown };
              orderResult?: unknown;
            };
          }
        | undefined;
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = undefined;
      }
      const code = data?.code as string | number | undefined;

      if (isXfyunOrderGone(code)) return { kind: 'order-gone' };
      if (String(code ?? '').trim() === '100013') {
        // 订单未完成：继续轮询。
        consecutiveFailures = 0;
        handled = true;
      } else {
        const cls = classifyXfyunCode(res.status, code ?? null);
        if (cls === 'success') {
          consecutiveFailures = 0;
          const info = data?.content?.orderInfo;
          const status = Number(info?.status);
          if (status === 4 || status === -1) {
            const failType = Number(info?.failType);
            if (
              status === 4 &&
              (!Number.isFinite(failType) || failType === 0)
            ) {
              return {
                kind: 'done',
                result: assembleResult(data?.content?.orderResult),
              };
            }
            if (failType === 6) {
              // 静音文件：按空结果成功（与本地引擎「无人声→空字幕」语义一致）。
              logMessage(
                'Xfyun ASR: silent audio (failType 6), returning empty result',
                'warning',
              );
              return {
                kind: 'done',
                result: {
                  text: '',
                  segments: [],
                  words: [],
                  hasWordTimestamps: false,
                },
              };
            }
            // 订单确定性完结（失败态）：标记 orderFinal，调用方据此清持久化记录。
            const failErr = new Error(
              `Xfyun ASR order failed: ${mapXfyunFailType(failType) ?? `status ${status}`}`,
            );
            (failErr as { orderFinal?: boolean }).orderFinal = true;
            throw failErr;
          }
          // status 0/3：处理中。
          handled = true;
        } else if (cls === 'auth') {
          // 鉴权失败：保留持久化记录（修好凭据后重跑仍可续查原订单）。
          const reason = String(data?.descInfo ?? '') || bodyText.slice(0, 300);
          throw new Error(
            `Xfyun ASR auth failed (code ${code}): ${reason}`.trim(),
          );
        } else if (cls === 'fatal') {
          // 业务性失败（参数类）：标记 orderFinal 清记录，避免重跑反复撞同一 poisoned 订单。
          const reason = String(data?.descInfo ?? '') || bodyText.slice(0, 300);
          const fatalErr = new Error(
            `Xfyun ASR getResult failed: HTTP ${res.status} code ${code ?? '(none)'} ${reason}`.trim(),
          );
          (fatalErr as { orderFinal?: boolean }).orderFinal = true;
          throw fatalErr;
        } else {
          // retriable：计入连续失败。
          consecutiveFailures += 1;
          logMessage(
            `Xfyun ASR poll: HTTP ${res.status} code ${code ?? '(none)'}, consecutive failures ${consecutiveFailures}/${POLL_MAX_CONSECUTIVE_FAILURES}`,
            'warning',
          );
          if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
            throw new Error(
              `Xfyun ASR poll failed ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row (last: HTTP ${res.status} code ${code ?? '(none)'})`,
            );
          }
          handled = true;
        }
      }
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error;
      if (signal?.aborted) throw new TaskCancelledError();
      if ((error as { retriable?: boolean })?.retriable === true) {
        consecutiveFailures += 1;
        logMessage(
          `Xfyun ASR poll: request error, consecutive failures ${consecutiveFailures}/${POLL_MAX_CONSECUTIVE_FAILURES}`,
          'warning',
        );
        if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) throw error;
        handled = true;
      } else {
        throw error;
      }
    }

    if (handled) {
      await sleep(pollIntervalMs(query), signal);
    }
  }

  // 次数/时长超限：订单大概率仍在服务端处理，保留持久化记录供重跑续查。
  throw new Error(
    'Xfyun ASR: order still processing after polling budget exhausted; rerun the task later to resume polling this order (no re-upload, no extra billing)',
  );
}

/** 组装转写结果；code 0 + 空文本（无人声等）按空结果成功。 */
function assembleResult(orderResult: unknown): AsrTranscribeResult {
  const { text, words, segments } = extractXfyunResult(orderResult);
  if (!text.trim()) {
    logMessage(
      'Xfyun ASR: empty transcription (silent audio?), returning empty result',
      'warning',
    );
    return { text: '', segments: [], words: [], hasWordTimestamps: false };
  }
  return { text, segments, words, hasWordTimestamps: words.length > 0 };
}

/**
 * 讯飞「录音文件转写大模型」转写（云 ASR 首个异步订单制 service）。
 *
 * 鉴权：APPID/APIKey/APISecret（映射 appId/accessKeyId/accessKeySecret），
 * 排序参数 HmacSHA1 签名进 `signature` 头，每次请求重取 dateTime 重签。
 * 流程：octet-stream 直传 upload 建单 → 梯度轮询 getResult（≤96 次且 ≤62min）→
 * lattice 解析出句级/词级时间戳（词级喂内置成句管线，标点已内联）。
 * `input.model` 为语种档位（autodialect/autominor），识别语言免切自动；
 * 档位不支持任务原语言时上传前报错（继续上传只会产出乱码还照常计费）。
 * 跨会话续查（design D10）：upload 成功即按「音频内容 hash + 实例 + 档位」持久化
 * orderId，应用重启后重跑同一任务跳过上传直接续查；订单完结删记录、
 * 轮询超限保留记录、订单失效清记录回落新上传。
 */
export async function transcribeWithXfyun(
  provider: AsrProvider,
  input: AsrTranscribeInput,
): Promise<AsrTranscribeResult> {
  const appid = String(provider?.appid ?? '').trim();
  const apiKey = String(provider?.apiKey ?? '').trim();
  const apiSecret = String(provider?.apiSecret ?? '').trim();
  if (!appid || !apiKey || !apiSecret) {
    throw new Error('Xfyun ASR: APPID / APIKey / APISecret are required');
  }
  if (!fs.existsSync(input.audioPath)) {
    throw new Error(`Xfyun ASR: audio file not found: ${input.audioPath}`);
  }

  const tier = normalizeXfyunTier(input.model);
  const support = resolveXfyunLanguageSupport(tier, input.language);
  if (support === 'switch-tier') {
    throw new Error(
      tier === 'autodialect'
        ? `Xfyun ASR: source language "${input.language}" is not covered by the autodialect tier (Chinese/English/dialects). Switch the model to autominor (37 languages, requires activation with iFlytek support)`
        : `Xfyun ASR: source language "${input.language}" is not covered by the autominor tier (37 languages). Switch the model to autodialect (Chinese/English/dialects)`,
    );
  }
  if (support === 'unsupported') {
    throw new Error(
      `Xfyun ASR: source language "${input.language}" is not supported by Xfyun transcription`,
    );
  }

  const creds: XfyunCredentials = { appid, apiKey, apiSecret };
  const timeoutMs =
    toPositiveNumber(provider.requestTimeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;
  const maxRetries = Math.max(
    0,
    Math.floor(toPositiveNumber(provider.maxRetries, DEFAULT_MAX_RETRIES)),
  );

  const audio = fs.readFileSync(input.audioPath);
  const orderKey = pendingOrderKey(audio, String(provider.id ?? ''), tier);
  let resumed: XfyunPendingOrder | undefined = readPendingOrders()[orderKey];

  for (;;) {
    throwIfSignalCancelled(input.signal);
    let orderId: string;
    let signatureRandom: string;
    let firstDelayMs: number;

    if (resumed) {
      orderId = resumed.orderId;
      signatureRandom = resumed.signatureRandom;
      firstDelayMs = 0;
      logMessage(
        `Xfyun ASR: resuming existing order ${orderId} (created ${Math.round((Date.now() - resumed.createdAt) / 60000)}min ago)`,
        'info',
      );
    } else {
      signatureRandom = buildXfyunRandom();
      const uploaded = await uploadOrder({
        creds,
        audio,
        audioPath: input.audioPath,
        tier,
        signatureRandom,
        timeoutMs,
        maxRetries,
        signal: input.signal,
      });
      orderId = uploaded.orderId;
      savePendingOrder(orderKey, {
        orderId,
        signatureRandom,
        createdAt: Date.now(),
      });
      // 首查延迟参考服务端预估（实测偏悲观，减半）钳制在 3~30s；预估缺失回落 5s。
      firstDelayMs =
        uploaded.taskEstimateTimeMs > 0
          ? Math.min(Math.max(uploaded.taskEstimateTimeMs / 2, 3_000), 30_000)
          : 5_000;
      logMessage(
        `Xfyun ASR: order ${orderId} created (estimate ${Math.round(uploaded.taskEstimateTimeMs / 1000)}s, tier ${tier})`,
        'info',
      );
    }

    try {
      const outcome = await pollOrder({
        creds,
        orderId,
        signatureRandom,
        firstDelayMs,
        timeoutMs,
        signal: input.signal,
      });
      if (outcome.kind === 'order-gone') {
        if (resumed) {
          // 持久化订单已失效（过期/被删）：清记录回落新上传。
          logMessage(
            `Xfyun ASR: resumed order ${orderId} no longer exists, falling back to a fresh upload`,
            'warning',
          );
          deletePendingOrder(orderKey);
          resumed = undefined;
          continue;
        }
        deletePendingOrder(orderKey);
        throw new Error(
          `Xfyun ASR: order ${orderId} not found right after creation`,
        );
      }
      deletePendingOrder(orderKey);
      return outcome.result;
    } catch (error) {
      // 仅「订单确定性完结/中毒」（status=-1、getResult 业务性失败）清记录；
      // 取消/轮询超限/网络连败/鉴权失败一律保留——订单仍在服务端跑，
      // 重跑续查（不重复计费），失效由 order-gone 回落与 72h TTL 兜底。
      if ((error as { orderFinal?: boolean })?.orderFinal === true) {
        deletePendingOrder(orderKey);
      }
      throw error;
    }
  }
}

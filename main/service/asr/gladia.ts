import fs from 'fs';
import path from 'path';
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
  GLADIA_PRERECORDED_PATH,
  GLADIA_UPLOAD_PATH,
  buildGladiaInitBody,
  classifyGladiaStatus,
  extractGladiaResult,
  isGladiaJobGone,
  normalizeGladiaBaseURL,
  normalizeGladiaModel,
  resolveGladiaLanguage,
} from './gladiaUtils';

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MAX_RETRIES = 2;

/** 轮询间隔梯度：Gladia 处理快（约 60s/小时音频），前密后疏（毫秒）。 */
const POLL_INTERVALS_MS: Array<{ intervalMs: number; times: number }> = [
  { intervalMs: 2_000, times: 10 },
  { intervalMs: 5_000, times: 24 },
  { intervalMs: 15_000, times: Number.POSITIVE_INFINITY },
];
/** 轮询总等待上限（自轮询起算）；到点保留持久化记录、重跑任务续查。 */
const POLL_MAX_WAIT_MS = 30 * 60 * 1000;
/** 单次查询失败（网络/超时/可重试码）连续达此次数判死。 */
const POLL_MAX_CONSECUTIVE_FAILURES = 5;

/** 跨会话续查记录有效期：对齐讯飞取 72h（Gladia 结果保留远长于此，取保守值足够）。 */
const PENDING_JOB_TTL_MS = 72 * 60 * 60 * 1000;
const PENDING_JOBS_KEY = 'gladiaPendingJobs';

interface GladiaPendingJob {
  id: string;
  createdAt: number;
}

/** 读全表并惰性清理过期记录（写回仅在有变化时）。 */
function readPendingJobs(): Record<string, GladiaPendingJob> {
  const raw = store.get(PENDING_JOBS_KEY) as
    | Record<string, GladiaPendingJob>
    | undefined;
  if (!raw || typeof raw !== 'object') return {};
  const now = Date.now();
  const alive: Record<string, GladiaPendingJob> = {};
  let dropped = 0;
  for (const [key, rec] of Object.entries(raw)) {
    if (
      rec &&
      typeof rec.id === 'string' &&
      Number.isFinite(rec.createdAt) &&
      now - rec.createdAt < PENDING_JOB_TTL_MS
    ) {
      alive[key] = rec;
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) store.set(PENDING_JOBS_KEY, alive);
  return alive;
}

function savePendingJob(key: string, record: GladiaPendingJob): void {
  const all = readPendingJobs();
  all[key] = record;
  store.set(PENDING_JOBS_KEY, all);
}

function deletePendingJob(key: string): void {
  const all = readPendingJobs();
  if (key in all) {
    delete all[key];
    store.set(PENDING_JOBS_KEY, all);
  }
}

/** 续查指纹：压缩音频内容 hash + 服务商实例 + 模型 + 语言（临时文件路径每次重跑都变，不可用）。 */
function pendingJobKey(
  audio: Buffer,
  providerId: string,
  model: string,
  language: string,
): string {
  const hash = crypto.createHash('sha1').update(audio).digest('hex');
  return `${hash}:${providerId}:${model}:${language}`;
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
async function fetchGladiaOnce(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: BodyInit },
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
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (externalSignal?.aborted) throw new TaskCancelledError();
    if (timedOut) {
      const e = new Error(`Gladia ASR request timed out after ${timeoutMs}ms`);
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

/** 从错误响应体抽取 message / validation_errors（Gladia 错误体形态）。 */
function readGladiaError(bodyText: string): string {
  try {
    const j = JSON.parse(bodyText) as {
      message?: unknown;
      validation_errors?: unknown;
    };
    const parts: string[] = [];
    if (j?.message) parts.push(String(j.message));
    if (Array.isArray(j?.validation_errors) && j.validation_errors.length) {
      parts.push(j.validation_errors.map(String).join('; '));
    }
    if (parts.length) return parts.join(' — ');
  } catch {
    /* 非 JSON：回落截断文本 */
  }
  return bodyText.slice(0, 300);
}

interface GladiaRequestContext {
  base: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  signal?: AbortSignal;
}

/**
 * 带重试的请求骨架：网络错误/超时/408/429/5xx 指数退避重试；
 * 401/403 报鉴权错误；其余 4xx 致命直抛（携服务端 message）。
 */
async function requestWithRetry(
  ctx: GladiaRequestContext,
  label: string,
  makeInit: () => {
    url: string;
    method?: string;
    headers: Record<string, string>;
    body?: BodyInit;
  },
): Promise<{ status: number; bodyText: string }> {
  let attempt = 0;
  for (;;) {
    throwIfSignalCancelled(ctx.signal);
    try {
      const { url, method, headers, body } = makeInit();
      const res = await fetchGladiaOnce(
        url,
        { method: method ?? 'POST', headers, body },
        ctx.timeoutMs,
        ctx.signal,
      );
      const bodyText = await res.text().catch(() => '');
      if (res.ok) return { status: res.status, bodyText };
      const cls = classifyGladiaStatus(res.status);
      if (cls === 'retriable' && attempt < ctx.maxRetries) {
        attempt += 1;
        logMessage(
          `Gladia ASR ${label}: HTTP ${res.status}, retry ${attempt}/${ctx.maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), ctx.signal);
        continue;
      }
      if (cls === 'auth') {
        throw new Error(
          `Gladia ASR auth failed (HTTP ${res.status}): ${readGladiaError(bodyText)} — check the API key`,
        );
      }
      throw new Error(
        `Gladia ASR ${label} failed: HTTP ${res.status} ${readGladiaError(bodyText)}`,
      );
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error;
      if (ctx.signal?.aborted) throw new TaskCancelledError();
      const retriable = (error as { retriable?: boolean })?.retriable === true;
      if (retriable && attempt < ctx.maxRetries) {
        attempt += 1;
        logMessage(
          `Gladia ASR ${label}: request error, retry ${attempt}/${ctx.maxRetries}`,
          'warning',
        );
        await sleep(500 * 2 ** (attempt - 1), ctx.signal);
        continue;
      }
      throw error;
    }
  }
}

/** 上传音频（multipart）→ 服务端临时 audio_url（有效期内可用于建任务）。 */
async function uploadAudio(
  ctx: GladiaRequestContext,
  audio: Buffer,
  audioPath: string,
): Promise<string> {
  const { bodyText } = await requestWithRetry(ctx, 'upload', () => {
    const form = new FormData();
    form.append(
      'audio',
      new Blob([audio as unknown as ArrayBuffer]),
      path.basename(audioPath) || 'audio.wav',
    );
    return {
      url: `${ctx.base}${GLADIA_UPLOAD_PATH}`,
      headers: { 'x-gladia-key': ctx.apiKey },
      body: form,
    };
  });
  let audioUrl = '';
  try {
    audioUrl = String(
      (JSON.parse(bodyText) as { audio_url?: unknown })?.audio_url ?? '',
    ).trim();
  } catch {
    /* 落空由下方守卫抛错 */
  }
  if (!audioUrl) {
    throw new Error('Gladia ASR upload succeeded but no audio_url returned');
  }
  return audioUrl;
}

/** 建转写任务 → job id。 */
async function initJob(
  ctx: GladiaRequestContext,
  audioUrl: string,
  model: string,
  language?: string,
): Promise<string> {
  const { bodyText } = await requestWithRetry(ctx, 'init', () => ({
    url: `${ctx.base}${GLADIA_PRERECORDED_PATH}`,
    headers: {
      'x-gladia-key': ctx.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildGladiaInitBody({ audioUrl, model, language })),
  }));
  let id = '';
  try {
    id = String((JSON.parse(bodyText) as { id?: unknown })?.id ?? '').trim();
  } catch {
    /* 落空由下方守卫抛错 */
  }
  if (!id) {
    throw new Error('Gladia ASR init succeeded but no job id returned');
  }
  return id;
}

type GladiaPollOutcome =
  | { kind: 'done'; result: AsrTranscribeResult }
  | { kind: 'job-gone' };

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
 * 轮询任务直至 done/error/失效/超限。
 * 单次查询失败不中止任务（连续 POLL_MAX_CONSECUTIVE_FAILURES 次判死）；
 * 401/403 立即抛错（保留续查记录，修好 key 重跑续查）；404 返回 job-gone 交调用方语义化；
 * status=error 为任务确定性完结（标记 jobFinal，调用方清持久化记录）。
 */
async function pollJob(
  ctx: GladiaRequestContext,
  jobId: string,
): Promise<GladiaPollOutcome> {
  const startedAt = Date.now();
  let consecutiveFailures = 0;

  for (let query = 0; ; query += 1) {
    throwIfSignalCancelled(ctx.signal);
    if (Date.now() - startedAt > POLL_MAX_WAIT_MS) break;

    try {
      const res = await fetchGladiaOnce(
        `${ctx.base}${GLADIA_PRERECORDED_PATH}/${jobId}`,
        { method: 'GET', headers: { 'x-gladia-key': ctx.apiKey } },
        ctx.timeoutMs,
        ctx.signal,
      );
      const bodyText = await res.text().catch(() => '');
      if (isGladiaJobGone(res.status)) return { kind: 'job-gone' };
      if (!res.ok) {
        const cls = classifyGladiaStatus(res.status);
        if (cls === 'auth') {
          throw new Error(
            `Gladia ASR auth failed (HTTP ${res.status}): ${readGladiaError(bodyText)} — check the API key`,
          );
        }
        if (cls === 'fatal') {
          const fatalErr = new Error(
            `Gladia ASR poll failed: HTTP ${res.status} ${readGladiaError(bodyText)}`,
          );
          (fatalErr as { jobFinal?: boolean }).jobFinal = true;
          throw fatalErr;
        }
        consecutiveFailures += 1;
        logMessage(
          `Gladia ASR poll: HTTP ${res.status}, consecutive failures ${consecutiveFailures}/${POLL_MAX_CONSECUTIVE_FAILURES}`,
          'warning',
        );
        if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
          throw new Error(
            `Gladia ASR poll failed ${POLL_MAX_CONSECUTIVE_FAILURES} times in a row (last: HTTP ${res.status})`,
          );
        }
      } else {
        consecutiveFailures = 0;
        let data: Record<string, unknown> | undefined;
        try {
          data = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          data = undefined;
        }
        const status = String(data?.status ?? '').toLowerCase();
        if (status === 'done') {
          return { kind: 'done', result: assembleResult(data) };
        }
        if (status === 'error') {
          // 任务确定性完结（转写失败）：标记 jobFinal，调用方清持久化记录。
          const code = data?.error_code;
          const failErr = new Error(
            `Gladia ASR job failed (error_code ${code ?? 'unknown'})`,
          );
          (failErr as { jobFinal?: boolean }).jobFinal = true;
          throw failErr;
        }
        // queued / processing：继续轮询。
      }
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error;
      if (ctx.signal?.aborted) throw new TaskCancelledError();
      if ((error as { retriable?: boolean })?.retriable === true) {
        consecutiveFailures += 1;
        logMessage(
          `Gladia ASR poll: request error, consecutive failures ${consecutiveFailures}/${POLL_MAX_CONSECUTIVE_FAILURES}`,
          'warning',
        );
        if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) throw error;
      } else {
        throw error;
      }
    }

    await sleep(pollIntervalMs(query), ctx.signal);
  }

  // 时长超限：任务大概率仍在服务端处理，保留持久化记录供重跑续查。
  throw new Error(
    'Gladia ASR: job still processing after polling budget exhausted; rerun the task later to resume polling this job (no re-upload, no extra billing)',
  );
}

/** 组装转写结果；done + 空文本（无人声等）按空结果成功。 */
function assembleResult(data: unknown): AsrTranscribeResult {
  const { text, words, segments, language, duration } =
    extractGladiaResult(data);
  if (!text.trim()) {
    logMessage(
      'Gladia ASR: empty transcription (silent audio?), returning empty result',
      'warning',
    );
    return { text: '', segments: [], words: [], hasWordTimestamps: false };
  }
  return {
    text,
    segments,
    words,
    language,
    duration,
    hasWordTimestamps: words.length > 0,
  };
}

/**
 * Gladia v2 pre-recorded 转写（异步任务制，`x-gladia-key` 头鉴权、无签名）。
 *
 * 流程：multipart 上传 → JSON 建任务（audio_url + model [+ language_config]）→
 * 梯度轮询 GET /v2/pre-recorded/{id} 直至 done/error →
 * utterances[].words 词级时间戳（标点内联）喂内置成句管线。
 * `input.model` 为 solaria-1（全语种默认）/ solaria-3（欧语实录特化）；
 * 语言 'auto'/空 → 服务端自动检测，明确语言先过支持清单守卫（不支持即报错，避免白计费）。
 * 跨会话续查（对齐讯飞 design D10）：init 成功即按「音频内容 hash + 实例 + 模型 + 语言」
 * 持久化 job id，应用重启后重跑同一任务跳过上传直接续查；任务完结删记录、
 * 轮询超限保留记录、任务失效（404）清记录回落新上传。
 */
export async function transcribeWithGladia(
  provider: AsrProvider,
  input: AsrTranscribeInput,
): Promise<AsrTranscribeResult> {
  const apiKey = String(provider?.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('Gladia ASR: API key is required');
  }
  if (!fs.existsSync(input.audioPath)) {
    throw new Error(`Gladia ASR: audio file not found: ${input.audioPath}`);
  }

  const model = normalizeGladiaModel(input.model);
  const lang = resolveGladiaLanguage(input.language);
  if (lang.kind === 'unsupported') {
    throw new Error(
      `Gladia ASR: source language "${input.language}" is not supported by Gladia transcription. Set the task source language to auto to let the server detect it`,
    );
  }
  const language = lang.kind === 'ok' ? lang.code : undefined;

  const ctx: GladiaRequestContext = {
    base: normalizeGladiaBaseURL(provider.apiUrl),
    apiKey,
    timeoutMs:
      toPositiveNumber(provider.requestTimeoutSec, DEFAULT_TIMEOUT_SEC) * 1000,
    maxRetries: Math.max(
      0,
      Math.floor(toPositiveNumber(provider.maxRetries, DEFAULT_MAX_RETRIES)),
    ),
    signal: input.signal,
  };

  const audio = fs.readFileSync(input.audioPath);
  const jobKey = pendingJobKey(
    audio,
    String(provider.id ?? ''),
    model,
    language ?? 'auto',
  );
  let resumed: GladiaPendingJob | undefined = readPendingJobs()[jobKey];

  for (;;) {
    throwIfSignalCancelled(input.signal);
    let jobId: string;

    if (resumed) {
      jobId = resumed.id;
      logMessage(
        `Gladia ASR: resuming existing job ${jobId} (created ${Math.round((Date.now() - resumed.createdAt) / 60000)}min ago)`,
        'info',
      );
    } else {
      const audioUrl = await uploadAudio(ctx, audio, input.audioPath);
      jobId = await initJob(ctx, audioUrl, model, language);
      savePendingJob(jobKey, { id: jobId, createdAt: Date.now() });
      logMessage(
        `Gladia ASR: job ${jobId} created (model ${model}, lang ${language ?? 'auto'})`,
        'info',
      );
    }

    try {
      const outcome = await pollJob(ctx, jobId);
      if (outcome.kind === 'job-gone') {
        if (resumed) {
          // 持久化任务已失效（过期/被删）：清记录回落新上传。
          logMessage(
            `Gladia ASR: resumed job ${jobId} no longer exists, falling back to a fresh upload`,
            'warning',
          );
          deletePendingJob(jobKey);
          resumed = undefined;
          continue;
        }
        deletePendingJob(jobKey);
        throw new Error(
          `Gladia ASR: job ${jobId} not found right after creation`,
        );
      }
      deletePendingJob(jobKey);
      return outcome.result;
    } catch (error) {
      // 仅「任务确定性完结」（status=error、轮询业务性失败）清记录；
      // 取消/轮询超限/网络连败/鉴权失败一律保留——任务仍在服务端跑，
      // 重跑续查（不重复计费），失效由 job-gone 回落与 72h TTL 兜底。
      if ((error as { jobFinal?: boolean })?.jobFinal === true) {
        deletePendingJob(jobKey);
      }
      throw error;
    }
  }
}

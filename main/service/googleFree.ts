import axios from 'axios';
import { convertLanguageCode } from '../helpers/utils';
import { logMessage } from '../helpers/storeManager';
import { TRANSLATION_REQUEST_TIMEOUT } from '../translate/constants';
import {
  acquire,
  resolveRateLimitConfig,
  type RateLimitConfig,
} from '../translate/utils/rateLimiter';
import {
  isTaskCancelledError,
  throwIfSignalCancelled,
} from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';
import {
  CHROME_ENDPOINT,
  buildChromeQuery,
  isAbusePage,
  parseChromeResponse,
  planChromeChunks,
  type ChromeChunk,
} from './googleFreeProtocol';

/**
 * Google 免费翻译，无需 API Key。内部有两条通道：
 * - chrome 通道：translate_a/t?client=dict-chrome-ex，一个请求翻译一批文本；
 * - gtx 通道：translate_a/single?client=gtx，一次只译一段，逐条请求（原有实现）。
 *
 * 每个块先走 chrome 通道，该通道不可用（冷却中或探测被占用）或本块失败时改走 gtx。
 * 两条通道各自维护进程内的健康状态：被限（429 / 403 加异常流量页）冷却 10 分钟起、翻倍到
 * 60 分钟封顶；其它失败连续 3 次冷却 120 秒；冷却结束后只放行一个探测请求。状态不落盘。
 * 非官方接口，可能随时变化或被限；证据与取舍见
 * openspec/changes/add-google-chrome-client-lane/design.md。
 */

const GTX_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_TIMEOUT_MS = 15_000;
/** 一块在 chrome 上最多问 2 次：只有因空项被拒绝的块才会问第二次（见 requestChrome）。 */
const CHROME_MAX_ASKS = 2;
const BLOCKED_BASE_COOLDOWN_MS = 10 * 60_000;
const BLOCKED_MAX_COOLDOWN_MS = 60 * 60_000;
const FAILURE_THRESHOLD = 3;
const FAILURE_COOLDOWN_MS = 120_000;
/** 带 `(network)`：含 403 / 401 的消息否则会被 isConfigurationError 当成配置错误而中止任务。 */
const ERROR_PREFIX = 'Google free translate failed (network)';

type LaneId = 'chrome' | 'gtx';
/** 通道顺序是内部常量，不是设置项。 */
const LANE_ORDER: LaneId[] = ['chrome', 'gtx'];

interface LaneState {
  /** 连续的普通失败次数（被限不计入）。 */
  failures: number;
  /** 连续被限的次数，决定下一次冷却时长。 */
  level: number;
  /** 冷却截止时间；0 表示健康。冷却结束后仍保持非 0，直到一次成功把它清零。 */
  coolUntil: number;
  /** 冷却结束后的探测请求正在进行。 */
  probing: boolean;
}

const freshLane = (): LaneState => ({
  failures: 0,
  level: 0,
  coolUntil: 0,
  probing: false,
});
const lanes: Record<LaneId, LaneState> = {
  chrome: freshLane(),
  gtx: freshLane(),
};

type FailureKind = 'blocked' | 'failure';

class LaneFailure extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind, detail: string) {
    super(detail);
    this.kind = kind;
  }
}

interface CallContext {
  signal?: AbortSignal;
  rateKey: string;
  rateCfg: RateLimitConfig;
}

function networkError(detail: string): Error {
  return new Error(`${ERROR_PREFIX}: ${detail}`);
}

/** 错误信息只含状态码或传输层消息，不含响应体、URL 与字幕文本。 */
function toLaneFailure(error: unknown): LaneFailure {
  if (error instanceof LaneFailure) return error;
  const failure = error as any;
  const status: number | undefined = failure?.response?.status;
  if (isAbusePage(status, failure?.response?.data)) {
    return new LaneFailure('blocked', `HTTP ${status} (blocked)`);
  }
  return new LaneFailure(
    'failure',
    status
      ? `HTTP ${status}`
      : String(failure?.message || 'request error').slice(0, 200),
  );
}

// ---------------------------------------------------------------------------
// 通道健康
// ---------------------------------------------------------------------------

interface LaneEntry {
  /** false：这条通道现在不能用。 */
  ok: boolean;
  /** ok 时：这次请求是冷却结束后的那个探测。 */
  probe?: boolean;
  /** 不 ok 时：还要等多久；探测进行中为 0。 */
  retryAfterMs?: number;
}

/** 申请使用一条通道：健康直接放行；冷却结束后只放行一个探测；其余视为不可用。 */
function enterLane(id: LaneId): LaneEntry {
  const lane = lanes[id];
  if (lane.coolUntil === 0) return { ok: true, probe: false };
  if (lane.probing) return { ok: false, retryAfterMs: 0 };
  const remaining = lane.coolUntil - Date.now();
  if (remaining > 0) return { ok: false, retryAfterMs: remaining };
  lane.probing = true;
  return { ok: true, probe: true };
}

function coolDown(id: LaneId, ms: number, kind: FailureKind): void {
  const lane = lanes[id];
  lane.coolUntil = Date.now() + ms;
  lane.probing = false;
  logMessage(
    `googleFree: ${id} lane ${kind}, cooling down for ${Math.round(ms / 1000)} s`,
    'warning',
  );
}

function recordSuccess(id: LaneId): void {
  const lane = lanes[id];
  const recovering = lane.coolUntil !== 0;
  lane.failures = 0;
  lane.level = 0;
  lane.coolUntil = 0;
  lane.probing = false;
  if (recovering) logMessage(`googleFree: ${id} lane recovered`, 'info');
}

function recordFailure(id: LaneId, kind: FailureKind, wasProbe: boolean): void {
  const lane = lanes[id];
  // 冷却开始之前就已发出的并发请求才失败：这次冷却已经由先到的失败触发，不重复升级
  if (lane.coolUntil !== 0 && !wasProbe) return;
  if (kind === 'blocked') {
    lane.level += 1;
    coolDown(
      id,
      Math.min(
        BLOCKED_BASE_COOLDOWN_MS * 2 ** (lane.level - 1),
        BLOCKED_MAX_COOLDOWN_MS,
      ),
      'blocked',
    );
    return;
  }
  lane.failures += 1;
  if (wasProbe || lane.failures >= FAILURE_THRESHOLD) {
    coolDown(id, FAILURE_COOLDOWN_MS, 'failure');
  }
}

/** 还要等多久才能用这条通道；null 表示现在可用（含冷却已结束、可以探测）。 */
function laneWait(id: LaneId): number | null {
  const lane = lanes[id];
  if (lane.coolUntil === 0) return null;
  if (lane.probing) return 0;
  const remaining = lane.coolUntil - Date.now();
  return remaining > 0 ? remaining : null;
}

/** 供回退链判断：两条通道都不可用时跳过谷歌，避免每个批次都先失败一次才切到下一源。 */
export function getGoogleFreeAvailability(): {
  available: boolean;
  retryAfterMs?: number;
} {
  const waits = LANE_ORDER.map(laneWait);
  if (waits.some((wait) => wait === null)) return { available: true };
  return {
    available: false,
    retryAfterMs: Math.min(...(waits as number[])),
  };
}

// ---------------------------------------------------------------------------
// 两条通道的请求
// ---------------------------------------------------------------------------

/**
 * chrome 通道：一块一个请求，整块有效或整块作废。仅因空项被拒绝的块（偶发的降级答案）用
 * 同样的请求整块再问一次，不混用两次的响应；条数与形状异常不重发。再问一次与其它请求一样先
 * `acquire`、响应取消、不写日志；两次合计在通道上最多算一次失败（由调用方记录）。
 */
async function requestChrome(
  texts: string[],
  sl: string,
  tl: string,
  ctx: CallContext,
): Promise<string[]> {
  const url = `${CHROME_ENDPOINT}?${buildChromeQuery(texts, sl, tl)}`;
  for (let ask = 1; ; ask += 1) {
    await acquire(ctx.rateKey, ctx.rateCfg, ctx.signal);
    let response;
    try {
      response = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: CHROME_TIMEOUT_MS,
        signal: ctx.signal,
      });
    } catch (error) {
      throwIfSignalCancelled(ctx.signal);
      throw toLaneFailure(error);
    }
    throwIfSignalCancelled(ctx.signal);

    const parsed = parseChromeResponse(response.data, texts.length);
    if (parsed.ok) return parsed.translations;
    if (parsed.emptyItems > 0 && ask < CHROME_MAX_ASKS) continue;
    throw new LaneFailure('failure', parsed.reason);
  }
}

/** gtx 通道：沿用原有请求，一条文本一个请求；任何一条失败则整块失败。 */
async function requestGtx(
  texts: string[],
  sl: string,
  tl: string,
  ctx: CallContext,
): Promise<string[]> {
  const translations: string[] = [];
  for (const text of texts) {
    await acquire(ctx.rateKey, ctx.rateCfg, ctx.signal);
    let response;
    try {
      response = await axios.get(GTX_ENDPOINT, {
        params: { client: 'gtx', sl, tl, dt: 't', q: text },
        headers: { 'User-Agent': USER_AGENT },
        timeout: TRANSLATION_REQUEST_TIMEOUT,
        signal: ctx.signal,
      });
    } catch (error) {
      throwIfSignalCancelled(ctx.signal);
      throw toLaneFailure(error);
    }
    throwIfSignalCancelled(ctx.signal);

    const data = response.data;
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new LaneFailure('failure', 'unexpected response');
    }
    // data[0] = [[translatedSegment, originalSegment, ...], ...]
    translations.push(
      data[0]
        .map((segment: any) =>
          Array.isArray(segment) && segment[0] ? segment[0] : '',
        )
        .join(''),
    );
  }
  return translations;
}

const REQUESTERS: Record<
  LaneId,
  (
    texts: string[],
    sl: string,
    tl: string,
    ctx: CallContext,
  ) => Promise<string[]>
> = { chrome: requestChrome, gtx: requestGtx };

function describeWait(retryAfterMs: number): string {
  const seconds = Math.ceil(retryAfterMs / 1000);
  return seconds > 0 ? `retry in ${seconds} s` : 'recovery probe in progress';
}

/**
 * 一个块：先 chrome，失败（含冷却中跳过）改走 gtx，每块最多切换一次、不循环。
 * 两条通道的结果不混用；两条都失败则整块失败，不返回部分结果。
 */
async function translateChunk(
  chunk: ChromeChunk,
  sl: string,
  tl: string,
  ctx: CallContext,
): Promise<string[]> {
  const notes: string[] = [];
  const waits: number[] = [];
  let attempted = false;

  for (const id of LANE_ORDER) {
    const entry = enterLane(id);
    if (!entry.ok) {
      waits.push(entry.retryAfterMs);
      notes.push(
        `${id} lane: cooling down (${describeWait(entry.retryAfterMs)})`,
      );
      continue;
    }
    attempted = true;
    try {
      const translations = await REQUESTERS[id](chunk.texts, sl, tl, ctx);
      recordSuccess(id);
      return translations;
    } catch (error) {
      // 取消不计入通道失败
      if (isTaskCancelledError(error)) throw error;
      const failure = toLaneFailure(error);
      recordFailure(id, failure.kind, entry.probe);
      notes.push(`${id} lane: ${failure.message}`);
    } finally {
      // a cancelled probe must not block the next one
      if (entry.probe) lanes[id].probing = false;
    }
  }

  if (!attempted) {
    throw networkError(
      `temporarily unavailable (both lanes cooling down, ${describeWait(Math.min(...waits))})`,
    );
  }
  throw networkError(notes.join('; '));
}

export default async function googleFree(
  query: string | string[],
  proof: Record<string, any>,
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  throwIfSignalCancelled(options?.signal);
  const list = Array.isArray(query) ? query : [query];
  const sl = convertLanguageCode(sourceLanguage, 'google') || 'auto';
  const tl = convertLanguageCode(targetLanguage, 'google');
  if (!tl) {
    throw new Error('not supported language');
  }

  const ctx: CallContext = {
    signal: options?.signal,
    rateKey: `googleFree:${proof?.id || 'googleFree'}`,
    rateCfg: resolveRateLimitConfig(proof),
  };

  // 空白条目不发请求，原样留在原位置
  const results = list.map((item) => (typeof item === 'string' ? item : ''));
  try {
    for (const chunk of planChromeChunks(list, sl, tl)) {
      const translations = await translateChunk(chunk, sl, tl, ctx);
      chunk.indexes.forEach((index, position) => {
        results[index] = translations[position];
      });
    }
  } catch (error) {
    if (isTaskCancelledError(error)) throw error;
    const message = String((error as Error)?.message || 'request error');
    throw message.startsWith(ERROR_PREFIX) ? error : networkError(message);
  }

  return Array.isArray(query) ? results : results[0];
}

export const __test__ = {
  reset: () => {
    lanes.chrome = freshLane();
    lanes.gtx = freshLane();
  },
  laneState: (id: LaneId) => ({ ...lanes[id] }),
};

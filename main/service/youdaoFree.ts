import axios from 'axios';
import { createDecipheriv, createHash } from 'crypto';
import { convertLanguageCode } from '../helpers/utils';
import { logMessage } from '../helpers/storeManager';
import {
  TaskCancelledError,
  isTaskCancelledError,
  throwIfSignalCancelled,
} from '../helpers/taskContext';
import {
  acquire,
  resolveRateLimitConfig,
  type RateLimitConfig,
} from '../translate/utils/rateLimiter';
import type { TranslationRequestOptions } from '../translate/types';
import {
  normalizeChineseTranslation,
  normalizeEcho,
  planCue,
  restoreCue,
} from './youdaoFreeText';

/**
 * 有道网页版免费翻译，无需 API Key。
 *
 * 流程与网页端一致：先请求站点首页拿到服务端下发的匿名访客 Cookie，再取签名与解密
 * 材料，随后发送带签名的表单，响应是 AES-128-CBC 加密的 JSON。建立会话后会用一条
 * 固定探针文本自检，因为签名失效时服务端不报错，而是返回 code 0 的无关「诱饵」译文。
 * 非官方接口，可能随时变化；协议核对方法与设计取舍见
 * openspec/changes/add-youdao-free-translator/design.md。
 */

// 协议常量取自有道网页端公开脚本（translation-website 1.0.8，2026-10-13 读取），
// 是网页客户端公开的协议参数，不是任何账号的凭据。
const SITE_URL = 'https://fanyi.youdao.com/';
const API_ORIGIN = 'https://dict.youdao.com';
const KEY_URL = `${API_ORIGIN}/webtranslate/key`;
const TRANSLATE_URL = `${API_ORIGIN}/webtranslate`;
const KEY_GETTER_KEYID = 'webfanyi-key-getter-2025';
const KEY_GETTER_SECRET = 'yU5nT5dK3eZ1pI4j';
const TRANSLATE_KEYID = 'webfanyi';
const CLIENT = 'fanyideskweb';
const PRODUCT = 'webfanyi';
const APP_VERSION = '12.0.0';
const VISITOR_COOKIE_NAME = 'OUTFOX_SEARCH_USER_ID';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_TEXT_LENGTH = 5000;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 120_000;

const PROBE_TEXT = 'Hello\nThank you';
const PROBE_EXPECTED = ['你好', '谢谢'];
const ERROR_PREFIX = 'Youdao free translate failed (network)';

interface Session {
  cookie: string;
  secretKey: string;
  aesKey: string;
  aesIv: string;
  establishedAt: number;
}

interface ParagraphResult {
  tgt: string;
  src: string;
}

type Outcome =
  | { kind: 'ok'; paragraphs: ParagraphResult[] }
  | { kind: 'retry'; reason: string }
  | { kind: 'unsupported' };

interface CallContext {
  signal?: AbortSignal;
  rateKey: string;
  rateCfg: RateLimitConfig;
}

let cachedSession: Session | undefined;
let pendingSession: Promise<Session> | undefined;

const breaker = { failures: 0, openUntil: 0, probing: false };

const md5 = (value: string) => createHash('md5').update(value).digest();
const md5Hex = (value: string) => createHash('md5').update(value).digest('hex');

function networkError(detail: string): Error {
  return new Error(`${ERROR_PREFIX}: ${detail}`);
}

function toNetworkError(error: any): Error {
  const status = error?.response?.status;
  return networkError(
    status ? `HTTP ${status}` : String(error?.message || 'request error'),
  );
}

function isUnsupportedLanguage(error: unknown): boolean {
  return String((error as Error)?.message).includes('not supported language');
}

/** 让调用方按自己的取消信号提前结束，而不中断被多个调用共享的会话建立。 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new TaskCancelledError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function signedFields(secret: string): Record<string, string> {
  const mysticTime = String(Date.now());
  return {
    sign: md5Hex(
      `client=${CLIENT}&mysticTime=${mysticTime}&product=${PRODUCT}&key=${secret}`,
    ),
    client: CLIENT,
    product: PRODUCT,
    appVersion: APP_VERSION,
    vendor: 'web',
    pointParam: 'client,mysticTime,product',
    mysticTime,
    keyfrom: 'fanyi.web',
    mid: '1',
    screen: '1',
    model: '1',
    network: 'wifi',
    abtest: '0',
    yduuid: 'abcdefg',
  };
}

function requestHeaders(cookie: string): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://fanyi.youdao.com',
    Referer: SITE_URL,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function extractVisitorCookie(headers: any): string {
  const raw = headers?.['set-cookie'];
  const entries: string[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? [raw]
      : [];
  for (const entry of entries) {
    const pair = entry.split(';')[0].trim();
    if (pair.startsWith(`${VISITOR_COOKIE_NAME}=`)) return pair;
  }
  return '';
}

async function fetchVisitorCookie(): Promise<string> {
  try {
    const response = await axios.get(SITE_URL, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    return extractVisitorCookie(response.headers);
  } catch (error) {
    throw toNetworkError(error);
  }
}

async function fetchKeyMaterial(
  cookie: string,
): Promise<Pick<Session, 'secretKey' | 'aesKey' | 'aesIv'>> {
  let data: any;
  try {
    const response = await axios.get(KEY_URL, {
      params: { keyid: KEY_GETTER_KEYID, ...signedFields(KEY_GETTER_SECRET) },
      headers: requestHeaders(cookie),
      timeout: REQUEST_TIMEOUT_MS,
    });
    data = response.data;
  } catch (error) {
    throw toNetworkError(error);
  }
  const { secretKey, aesKey, aesIv } = data?.data || {};
  if (
    data?.code !== 0 ||
    typeof secretKey !== 'string' ||
    typeof aesKey !== 'string' ||
    typeof aesIv !== 'string' ||
    !secretKey ||
    !aesKey ||
    !aesIv
  ) {
    throw networkError('invalid key response');
  }
  return { secretKey, aesKey, aesIv };
}

function decryptPayload(raw: unknown, session: Session): any {
  if (typeof raw !== 'string' || !raw) throw new Error('empty body');
  const decipher = createDecipheriv(
    'aes-128-cbc',
    md5(session.aesKey),
    md5(session.aesIv),
  );
  const plain = decipher.update(raw, 'base64', 'utf8') + decipher.final('utf8');
  return JSON.parse(plain);
}

/**
 * 合法响应的 translateResult 是「段落数组，每段是句子对象数组」。签名失效时服务端
 * 返回扁平的对象数组（内容与输入无关），这里一律判为不合法。
 */
function parseParagraphs(result: unknown): ParagraphResult[] | null {
  if (!Array.isArray(result)) return null;
  const paragraphs: ParagraphResult[] = [];
  for (const sentences of result) {
    if (!Array.isArray(sentences) || sentences.length === 0) return null;
    let tgt = '';
    let src = '';
    for (const sentence of sentences) {
      if (
        typeof sentence?.tgt !== 'string' ||
        typeof sentence?.src !== 'string'
      ) {
        return null;
      }
      tgt += sentence.tgt;
      src += sentence.src;
    }
    paragraphs.push({ tgt, src });
  }
  return paragraphs;
}

function interpret(payload: any): Outcome {
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.code !== 'number'
  ) {
    return { kind: 'retry', reason: 'unexpected response' };
  }
  if (payload.code === 21 || payload.code === 40)
    return { kind: 'unsupported' };
  if (payload.code === 50) {
    return { kind: 'retry', reason: 'verification failed (code 50)' };
  }
  if (payload.code !== 0) {
    throw networkError(`service returned code ${payload.code}`);
  }
  const raw = payload.translateResult;
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) {
    return { kind: 'retry', reason: 'empty result' };
  }
  const paragraphs = parseParagraphs(raw);
  if (!paragraphs) {
    return { kind: 'retry', reason: 'response shape rejected (decoy)' };
  }
  if (paragraphs.every((paragraph) => !paragraph.tgt.trim())) {
    return { kind: 'retry', reason: 'empty result' };
  }
  return { kind: 'ok', paragraphs };
}

async function requestOnce(
  session: Session,
  text: string,
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<Outcome> {
  const body = new URLSearchParams({
    i: text,
    from,
    to,
    useTerm: 'false',
    dictResult: 'false',
    keyid: TRANSLATE_KEYID,
    noCheckPrivate: 'false',
    ...signedFields(session.secretKey),
  });
  let raw: unknown;
  try {
    const response = await axios.post(TRANSLATE_URL, body.toString(), {
      headers: {
        ...requestHeaders(session.cookie),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: REQUEST_TIMEOUT_MS,
      signal,
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    raw = response.data;
  } catch (error) {
    throwIfSignalCancelled(signal);
    throw toNetworkError(error);
  }
  throwIfSignalCancelled(signal);

  let payload: any;
  try {
    payload = decryptPayload(raw, session);
  } catch {
    return { kind: 'retry', reason: 'unreadable response' };
  }
  return interpret(payload);
}

async function runProbe(session: Session, ctx: CallContext): Promise<void> {
  await acquire(ctx.rateKey, ctx.rateCfg);
  const outcome = await requestOnce(session, PROBE_TEXT, 'en', 'zh-CHS');
  if (outcome.kind !== 'ok') {
    throw networkError(
      `session probe failed (${outcome.kind === 'retry' ? outcome.reason : 'unsupported'})`,
    );
  }
  const { paragraphs } = outcome;
  if (
    paragraphs.length !== PROBE_EXPECTED.length ||
    !paragraphs.every((paragraph, index) =>
      paragraph.tgt.includes(PROBE_EXPECTED[index]),
    )
  ) {
    throw networkError('session probe failed (unexpected translation)');
  }
}

async function establishSession(ctx: CallContext): Promise<Session> {
  const cookie = await fetchVisitorCookie();
  const keys = await fetchKeyMaterial(cookie);
  const session: Session = { cookie, ...keys, establishedAt: Date.now() };
  try {
    await runProbe(session, ctx);
  } catch (error) {
    logMessage(
      `youdaoFree: session probe failed (${String((error as Error)?.message).replace(`${ERROR_PREFIX}: `, '')})`,
      'warning',
    );
    throw error;
  }
  logMessage('youdaoFree: session established', 'info');
  return session;
}

/**
 * 取会话凭据：缓存期内复用；并发调用共用同一次建立；传入已失效的会话时
 * 重建（若别人已经换过新的就直接用新的）。
 */
async function getSession(ctx: CallContext, stale?: Session): Promise<Session> {
  if (
    cachedSession &&
    cachedSession !== stale &&
    Date.now() - cachedSession.establishedAt < SESSION_TTL_MS
  ) {
    return cachedSession;
  }
  if (stale && cachedSession === stale) cachedSession = undefined;
  if (!pendingSession) {
    pendingSession = establishSession(ctx).then(
      (session) => {
        cachedSession = session;
        pendingSession = undefined;
        return session;
      },
      (error) => {
        pendingSession = undefined;
        throw error;
      },
    );
  }
  return raceAbort(pendingSession, ctx.signal);
}

/** 失败状态（含冷却）由调用级汇总：成功清零、失败累计、冷却后放行一次探测。 */
function breakerGate(): boolean {
  if (breaker.openUntil === 0) return false;
  const now = Date.now();
  if (breaker.probing) {
    throw networkError(
      'temporarily unavailable (cooling down, recovery probe in progress)',
    );
  }
  if (now < breaker.openUntil) {
    throw networkError(
      `temporarily unavailable (cooling down, retry in ${Math.ceil((breaker.openUntil - now) / 1000)} s)`,
    );
  }
  breaker.probing = true;
  return true;
}

function recordServiceAlive(): void {
  if (breaker.openUntil !== 0) {
    logMessage('youdaoFree: service recovered, cooldown cleared', 'info');
  }
  breaker.failures = 0;
  breaker.openUntil = 0;
  breaker.probing = false;
}

function recordFailure(wasProbe: boolean): void {
  breaker.failures += 1;
  if (wasProbe || breaker.failures >= BREAKER_THRESHOLD) {
    breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    breaker.probing = false;
    logMessage(
      `youdaoFree: ${breaker.failures} consecutive failures, cooling down for ${BREAKER_COOLDOWN_MS / 1000} s`,
      'warning',
    );
  }
}

/** 供回退链判断：冷却期内直接跳过有道，避免每个批次都先失败一次。 */
export function getYoudaoFreeAvailability(): {
  available: boolean;
  retryAfterMs?: number;
} {
  if (breaker.openUntil === 0) return { available: true };
  if (breaker.probing) return { available: false, retryAfterMs: 0 };
  const remaining = breaker.openUntil - Date.now();
  return remaining > 0
    ? { available: false, retryAfterMs: remaining }
    : { available: true };
}

/** 发出一个翻译请求；会话失效（验证失败、诱饵、空结果、无法解密）时重建后只重试一次。 */
async function requestParagraphs(
  text: string,
  from: string,
  to: string,
  ctx: CallContext,
): Promise<ParagraphResult[]> {
  let session = await getSession(ctx);
  for (let attempt = 0; ; attempt += 1) {
    throwIfSignalCancelled(ctx.signal);
    await acquire(ctx.rateKey, ctx.rateCfg, ctx.signal);
    const outcome = await requestOnce(session, text, from, to, ctx.signal);
    if (outcome.kind === 'ok') {
      recordServiceAlive();
      return outcome.paragraphs;
    }
    if (outcome.kind === 'unsupported') {
      recordServiceAlive();
      throw new Error('not supported language');
    }
    if (attempt >= 1) {
      throw networkError(`${outcome.reason} after rebuilding the session`);
    }
    logMessage(
      `youdaoFree: rebuilding the session (${outcome.reason})`,
      'warning',
    );
    session = await getSession(ctx, session);
  }
}

function isAligned(results: ParagraphResult[], expected: string[]): boolean {
  return (
    results.length === expected.length &&
    results.every(
      (result, index) =>
        result.tgt.trim() !== '' &&
        normalizeEcho(result.src) === normalizeEcho(expected[index]),
    )
  );
}

async function translateChunk(
  paragraphs: string[],
  from: string,
  to: string,
  ctx: CallContext,
): Promise<string[]> {
  const results = await requestParagraphs(paragraphs.join('\n'), from, to, ctx);
  if (isAligned(results, paragraphs)) return results.map((r) => r.tgt);

  if (paragraphs.length === 1) {
    throw networkError('response does not match the request');
  }
  logMessage(
    `youdaoFree: response did not align (${results.length} of ${paragraphs.length} paragraphs), retrying one by one`,
    'warning',
  );
  const translations: string[] = [];
  for (const paragraph of paragraphs) {
    const single = await requestParagraphs(paragraph, from, to, ctx);
    if (!isAligned(single, [paragraph])) {
      throw networkError('response does not match the request');
    }
    translations.push(single[0].tgt);
  }
  return translations;
}

function splitIntoChunks(paragraphs: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    const joined =
      current.length === 0 ? paragraph.length : length + 1 + paragraph.length;
    if (current.length > 0 && joined > MAX_TEXT_LENGTH) {
      chunks.push(current);
      current = [paragraph];
      length = paragraph.length;
    } else {
      current.push(paragraph);
      length = joined;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export default async function youdaoFree(
  query: string | string[],
  proof: Record<string, any>,
  sourceLanguage: string,
  targetLanguage: string,
  options?: TranslationRequestOptions,
): Promise<string | string[]> {
  throwIfSignalCancelled(options?.signal);
  const list = Array.isArray(query) ? query : [query];

  const to = convertLanguageCode(targetLanguage, 'youdao');
  const from =
    !sourceLanguage || sourceLanguage.toLowerCase() === 'auto'
      ? 'auto'
      : convertLanguageCode(sourceLanguage, 'youdao');
  if (!to || !from) {
    throw new Error('not supported language');
  }

  const plans = list.map((cue) => planCue(typeof cue === 'string' ? cue : ''));
  const paragraphs = plans.flatMap((plan) =>
    plan.paragraphs.map((paragraph) => paragraph.send),
  );
  const assemble = (translations: string[]) => {
    const chinese = to === 'zh-CHS' || to === 'zh-CHT';
    let cursor = 0;
    const results = plans.map((plan) => {
      const own = translations.slice(cursor, cursor + plan.paragraphs.length);
      cursor += plan.paragraphs.length;
      return restoreCue(
        plan,
        chinese ? own.map(normalizeChineseTranslation) : own,
      );
    });
    return Array.isArray(query) ? results : results[0];
  };
  if (paragraphs.length === 0) return assemble([]);

  const probing = breakerGate();
  const ctx: CallContext = {
    signal: options?.signal,
    rateKey: `youdaoFree:${proof?.id || 'youdaoFree'}`,
    rateCfg: resolveRateLimitConfig(proof),
  };
  try {
    const translations: string[] = [];
    for (const chunk of splitIntoChunks(paragraphs)) {
      translations.push(...(await translateChunk(chunk, from, to, ctx)));
    }
    return assemble(translations);
  } catch (error) {
    if (isTaskCancelledError(error) || isUnsupportedLanguage(error)) {
      throw error;
    }
    recordFailure(probing);
    throw String((error as Error)?.message).startsWith(ERROR_PREFIX)
      ? error
      : networkError(String((error as Error)?.message || 'request error'));
  } finally {
    // a cancelled probe must not block the next one
    if (probing && breaker.probing) breaker.probing = false;
  }
}

export const __test__ = {
  KEY_GETTER_SECRET,
  reset: () => {
    cachedSession = undefined;
    pendingSession = undefined;
    breaker.failures = 0;
    breaker.openUntil = 0;
    breaker.probing = false;
  },
  breakerState: () => ({ ...breaker }),
};

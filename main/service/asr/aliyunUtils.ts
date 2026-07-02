/**
 * 阿里云 NLS「录音文件识别极速版」（`nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/FlashRecognizer`）
 * 的纯工具（无网络 / fs / electron，node:crypto 仅做本地签名），便于 test:engines 单测。
 *
 * 鉴权两段式（design D2）：识别接口只认 `appkey + token`（URL 参数）；token 经
 * CreateToken（POP/RPC 风格，nls-meta 端点）以 AccessKey 签名获取——参数字典序排序、
 * 逐 k/v RFC3986 percentEncode、原文 `GET&%2F&{query}`、HMAC-SHA1(Secret+"&") → base64。
 * 识别语种绑定控制台项目（appkey），请求无语言参数——多语种以多实例组织（design D1）。
 */
import crypto from 'crypto';
import type { AsrSegment, AsrWord } from './types';
import { needsSpaceBefore } from '../../helpers/engines/cloudAsrShared';

/** 识别网关（固定上海地域，签名无关但端点不开放自定义，design D3）。 */
export const ALIYUN_NLS_GATEWAY_HOST = 'nls-gateway-cn-shanghai.aliyuncs.com';
export const ALIYUN_FLASH_PATH = '/stream/v1/FlashRecognizer';
/** CreateToken 取号端点（POP RPC）。 */
export const ALIYUN_META_HOST = 'nls-meta.cn-shanghai.aliyuncs.com';

/**
 * RFC3986 口径 percentEncode：`encodeURIComponent` 已符合大部分口径（空格→%20、
 * 保留 `-_.~`），补转其不转的 `!'()*` 五个字符（POP 签名对编码口径严格，错一个即 401）。
 */
export function percentEncodeRfc3986(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

/**
 * 构造 CreateToken 的规范化查询串：9 个公共参数按 key 字典序排序、
 * 逐 k/v percentEncode 后 `k=v&` 拼接。该串既是签名原文的一部分，也是最终请求串。
 */
export function buildCreateTokenQuery(
  accessKeyId: string,
  nonce: string,
  timestampIso: string,
): string {
  const params: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: 'CreateToken',
    Version: '2019-02-28',
    Format: 'JSON',
    RegionId: 'cn-shanghai',
    Timestamp: timestampIso,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: nonce,
  };
  return Object.keys(params)
    .sort()
    .map((k) => `${percentEncodeRfc3986(k)}=${percentEncodeRfc3986(params[k])}`)
    .join('&');
}

/**
 * POP 签名：原文 = `GET&%2F&percentEncode(sortedQuery)`，HMAC-SHA1
 * （key = AccessKeySecret + "&"）后 base64。返回裸签名值——拼 URL 时调用方需再
 * percentEncode（base64 的 `+/=` 均非 URL 安全）。
 */
export function signCreateToken(
  accessKeySecret: string,
  sortedQuery: string,
): string {
  const strToSign = `GET&${percentEncodeRfc3986('/')}&${percentEncodeRfc3986(sortedQuery)}`;
  return crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(strToSign)
    .digest('base64');
}

/**
 * Token 过期判定：ExpireTime 为**秒级绝对时间戳**（实测有效期 ≈36h，非固定时长），
 * 提前 marginSec（默认 5 分钟）视为过期——吸收时钟偏差与大文件上传耗时。
 */
export function isTokenExpired(
  expireTimeSec: number,
  nowMs: number,
  marginSec = 300,
): boolean {
  if (!Number.isFinite(expireTimeSec) || expireTimeSec <= 0) return true;
  return nowMs >= (expireTimeSec - marginSec) * 1000;
}

/**
 * 构造 FlashRecognizer 查询串（参数全为 URL 安全值，无编码歧义）：
 * - `enable_word_level_result=true`：词级时间戳（词带独立 punc 字段）；
 * - `enable_inverse_text_normalization=false`：ITN 关闭对齐其他服务商（数字形态交下游）；
 * - `first_channel_only=true`：恒单声道产物，显式声明避免多声道叠加计费；
 * - `sample_rate=16000`：匹配音频准备产物（16kHz WAV / 32kbps mp3，服务端自动重采样兜底）。
 */
export function buildFlashQuery(options: {
  appkey: string;
  token: string;
  format: string;
}): string {
  return [
    `appkey=${options.appkey}`,
    `token=${options.token}`,
    `format=${options.format}`,
    'sample_rate=16000',
    'enable_word_level_result=true',
    'enable_inverse_text_normalization=false',
    'first_channel_only=true',
  ].join('&');
}

/** 阿里 words 级时间戳实测为字符串毫秒（"880"）、sentences 级为数字；统一宽容换算秒。 */
function msToSec(value: unknown): number {
  return Number(value) / 1000;
}

/**
 * 从极速版响应体提取 { text, words, segments }：
 * - `flash_result.sentences[].words[]` 拍平 → AsrWord（秒）：**词文本 = trim(text) + trim(punc)**——
 *   punc 为词尾标点独立字段，拼接即得天然带标点的词序列（比腾讯整段回贴更可靠）；
 *   实测英文 text/punc 均可能带尾空格（"welcome " / ". "），不 trim 会与下游拉丁词
 *   补前置空格逻辑叠出双空格（中文无空格，trim 幂等）；
 * - `sentences[]`（分句、带标点、毫秒）→ AsrSegment（秒），作缺词级时的段级兜底；
 * - `text` = 各句 text（trim 后）拼接，CJK 直拼、拉丁句间补空格（needsSpaceBefore）。
 */
export function extractAliyunResult(data: unknown): {
  text: string;
  words: AsrWord[];
  segments: AsrSegment[];
} {
  const flashResult = (data as { flash_result?: unknown })?.flash_result;
  const sentences = (flashResult as { sentences?: unknown })?.sentences;
  const words: AsrWord[] = [];
  const segments: AsrSegment[] = [];
  const sentenceTexts: string[] = [];
  if (Array.isArray(sentences)) {
    for (const s of sentences) {
      const sStart = msToSec((s as { begin_time?: unknown })?.begin_time);
      const sEnd = msToSec((s as { end_time?: unknown })?.end_time);
      const sText = String((s as { text?: unknown })?.text ?? '').trim();
      if (sText) sentenceTexts.push(sText);
      if (Number.isFinite(sStart) && Number.isFinite(sEnd) && sText) {
        segments.push({ start: sStart, end: sEnd, text: sText });
      }
      const wordList = (s as { words?: unknown })?.words;
      if (!Array.isArray(wordList)) continue;
      for (const w of wordList) {
        const token = String((w as { text?: unknown })?.text ?? '').trim();
        const punc = String((w as { punc?: unknown })?.punc ?? '').trim();
        const word = token + punc;
        if (!word) continue;
        const start = msToSec((w as { begin_time?: unknown })?.begin_time);
        const end = msToSec((w as { end_time?: unknown })?.end_time);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          words.push({ word, start, end });
        }
      }
    }
  }
  let text = '';
  for (const t of sentenceTexts) {
    text += text && needsSpaceBefore(t) ? ` ${t}` : t;
  }
  return { text, words, segments };
}

/**
 * 状态分类（官方错误码表 + 实测校准，响应体 `status` 字段）：
 * - success：`20000000`
 * - empty：`40270002` 无有效语音（实测静音返回 "vad silent"）→ 空结果成功（探测判通过）
 * - auth：`40000001` Token 过期/非法、HTTP/status `403` → 清缓存强刷 Token 原地重试一次
 * - retriable：`40000004` 空闲超时（官方明示重试 ≤2）、`40000005` 并发超限、
 *   `50000000/50000001/52010001` 服务端偶发、HTTP 429/5xx
 * - fatal：`40000003` 参数、`40000009` WAV 头、`40000010` 未开通商用/欠费（实测先于
 *   appkey 校验）、`40010001` 路径、`40020105/40020106` appkey 不存在/不匹配、
 *   `40270001/40270003` 格式/解码、其余未知码 → 不重试、携 status+message 报错
 */
export type AliyunStatusClass =
  | 'success'
  | 'empty'
  | 'auth'
  | 'retriable'
  | 'fatal';

const ALIYUN_RETRIABLE_STATUSES = new Set([
  40000004, 40000005, 50000000, 50000001, 52010001,
]);

export function classifyAliyunStatus(
  httpStatus: number,
  status?: number | string | null,
): AliyunStatusClass {
  const numeric = Number(String(status ?? '').trim());
  const hasStatus =
    status !== null && status !== undefined && Number.isFinite(numeric);
  if (hasStatus) {
    if (numeric === 20000000) return 'success';
    if (numeric === 40270002) return 'empty';
    if (numeric === 40000001 || numeric === 403) return 'auth';
    if (ALIYUN_RETRIABLE_STATUSES.has(numeric)) return 'retriable';
  }
  if (httpStatus === 403) return 'auth';
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) {
    return 'retriable';
  }
  return 'fatal';
}

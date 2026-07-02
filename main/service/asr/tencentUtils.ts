/**
 * 腾讯云「录音文件识别极速版」（`asr.cloud.tencent.com/asr/flash/v1`）的
 * 纯工具（无网络 / fs / electron，node:crypto 仅做本地签名），便于 test:engines 单测。
 *
 * 鉴权为签名 v1：全部 URL 参数按字典序排序拼接原文 → HMAC-SHA1(SecretKey) → base64，
 * 放 `Authorization` 头（裸签名值）。签名原文绑定 Host，故端点不开放自定义（design D1）。
 */
import crypto from 'crypto';
import type { AsrSegment, AsrWord } from './types';

export const TENCENT_ASR_HOST = 'asr.cloud.tencent.com';
/** 尾部斜杠后直接拼 appid：`/asr/flash/v1/{appid}?{query}`。 */
export const TENCENT_FLASH_PATH = '/asr/flash/v1/';

/**
 * 「模型档位 + 任务原语言」→ engine_type 映射表（引擎即识别语言，语言跟随任务原语言，
 * 用户只选计费档位：standard 普通版 / large 大模型版——识别更强、单价更高、免费并发仅 5）。
 * - large 档中英粤走 16k_zh_en（中英粤+方言大模型），其余语种走 16k_multi_lang
 *   （15 语种自动识别大模型，注意**不含中文**）；
 * - auto（自动识别）：standard → 16k_zh-PY（中英粤三语混合，普通版计费）、
 *   large → 16k_zh_en——腾讯无全语种自动引擎，auto 按中英粤混合处理，
 *   非中英粤内容需在任务里明确选择原语言；
 * - 键为小写 ISO-639-1（zh-hant 繁体按普通话语音处理；tl/fil 同菲律宾语）。
 */
const TENCENT_LANG_ENGINE: Record<string, { standard: string; large: string }> =
  {
    auto: { standard: '16k_zh-PY', large: '16k_zh_en' },
    zh: { standard: '16k_zh', large: '16k_zh_en' },
    'zh-hant': { standard: '16k_zh', large: '16k_zh_en' },
    yue: { standard: '16k_yue', large: '16k_zh_en' },
    en: { standard: '16k_en', large: '16k_zh_en' },
    ja: { standard: '16k_ja', large: '16k_multi_lang' },
    ko: { standard: '16k_ko', large: '16k_multi_lang' },
    th: { standard: '16k_th', large: '16k_multi_lang' },
    vi: { standard: '16k_vi', large: '16k_multi_lang' },
    id: { standard: '16k_id', large: '16k_multi_lang' },
    ms: { standard: '16k_ms', large: '16k_multi_lang' },
    fil: { standard: '16k_fil', large: '16k_multi_lang' },
    tl: { standard: '16k_fil', large: '16k_multi_lang' },
    pt: { standard: '16k_pt', large: '16k_multi_lang' },
    tr: { standard: '16k_tr', large: '16k_multi_lang' },
    ar: { standard: '16k_ar', large: '16k_multi_lang' },
    es: { standard: '16k_es', large: '16k_multi_lang' },
    hi: { standard: '16k_hi', large: '16k_multi_lang' },
    fr: { standard: '16k_fr', large: '16k_multi_lang' },
    de: { standard: '16k_de', large: '16k_multi_lang' },
  };

/**
 * 解析任务所选「模型档位 + 原语言」为 engine_type：
 * - model 已是原始 engine_type（`16k_*`/`8k_*`，历史存量或高级用法）→ 原样透传、忽略语言；
 * - 否则 model 视为档位（'large' 为大模型版，其余含空值一律按 'standard'），按语言查表；
 * - 语言不在支持清单 → 返回 null，调用方应在上传前明确报错（腾讯不支持该语言，
 *   继续上传只会产出乱码还照常计费）。
 */
export function resolveTencentEngineType(
  model: string | undefined,
  language: string | undefined,
): string | null {
  const m = String(model ?? '').trim();
  if (/^(16k|8k)_/i.test(m)) return m;
  const tier: 'standard' | 'large' =
    m.toLowerCase() === 'large' ? 'large' : 'standard';
  const lang =
    String(language ?? '')
      .trim()
      .toLowerCase() || 'auto';
  const entry = TENCENT_LANG_ENGINE[lang];
  return entry ? entry[tier] : null;
}

/**
 * 构造请求参数集（固定 URL 安全值，无编码歧义——热词等含特殊字符参数刻意不支持）：
 * - `word_info=1`：词级时间戳（词无标点），标点由引擎侧 realignPunctuation 从整段文本回贴；
 * - `filter_punc=0`：整段 text 保留标点（回贴的标点来源）；
 * - `convert_num_mode=1`：数字智能转换（对齐既有服务商 ITN 行为）；
 * - `first_channel_only=1`：恒单声道产物，显式声明避免多声道计费歧义；
 * - `speaker_diarization=0`：说话人分离不在本期范围。
 */
export function buildTencentParams(options: {
  secretId: string;
  engineType: string;
  voiceFormat: string;
  timestamp: number;
}): Record<string, string> {
  return {
    secretid: options.secretId,
    engine_type: options.engineType,
    voice_format: options.voiceFormat,
    timestamp: String(options.timestamp),
    word_info: '1',
    filter_punc: '0',
    convert_num_mode: '1',
    first_channel_only: '1',
    speaker_diarization: '0',
  };
}

/**
 * 参数按 key 字典序排序、`k=v` 以 `&` 拼接。参数值均为 URL 安全字符
 * （字母数字与 `_`/`-`），排序串与最终请求 URL 完全一致，签名无编码歧义。
 */
export function buildTencentQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/**
 * 签名 v1：原文 = `POST` + host + path + appid + `?` + 排序后查询串，
 * HMAC-SHA1(SecretKey) 后 base64。服务端校验 timestamp ±3 分钟时效，
 * 调用方须每次请求（含重试）重取 timestamp 重签。
 */
export function signTencentRequest(
  secretKey: string,
  appid: string,
  sortedQuery: string,
): string {
  const signText = `POST${TENCENT_ASR_HOST}${TENCENT_FLASH_PATH}${appid}?${sortedQuery}`;
  return crypto.createHmac('sha1', secretKey).update(signText).digest('base64');
}

/**
 * 由文件扩展名映射 `voice_format`。引擎准备产物仅 wav（原始/切片）或 mp3（压缩），
 * 其余已知格式透传，未知/缺失回落 wav。
 */
export function voiceFormatFromPath(filePath: string): string {
  const ext = String(filePath ?? '')
    .split('.')
    .pop()
    ?.toLowerCase()
    ?.trim();
  if (!ext || /[\\/]/.test(ext)) return 'wav';
  if (ext === 'ogg' || ext === 'opus') return 'ogg-opus';
  return ext;
}

/** 腾讯 sentence/word 时间戳均为毫秒；换算秒。 */
function msToSec(value: unknown): number {
  return Number(value) / 1000;
}

/**
 * 从极速版响应体提取 { text, words, segments }（仅取 flash_result[0]，恒单声道）：
 * - `text`：整段带标点文本（供词级路径做标点回贴）；
 * - `sentence_list[].word_list[]`（逐词、无标点、毫秒）拍平 → AsrWord（秒）；
 * - `sentence_list[]`（分句、带标点、毫秒）→ AsrSegment（秒），作缺词级时的段级兜底。
 */
export function extractTencentResult(data: unknown): {
  text: string;
  words: AsrWord[];
  segments: AsrSegment[];
} {
  const flashResult = (data as { flash_result?: unknown })?.flash_result;
  const first = Array.isArray(flashResult) ? flashResult[0] : undefined;
  const text = String((first as { text?: unknown })?.text ?? '');
  const sentences = (first as { sentence_list?: unknown })?.sentence_list;
  const words: AsrWord[] = [];
  const segments: AsrSegment[] = [];
  if (Array.isArray(sentences)) {
    for (const s of sentences) {
      const sStart = msToSec((s as { start_time?: unknown })?.start_time);
      const sEnd = msToSec((s as { end_time?: unknown })?.end_time);
      const sText = String((s as { text?: unknown })?.text ?? '').trim();
      if (Number.isFinite(sStart) && Number.isFinite(sEnd) && sText) {
        segments.push({ start: sStart, end: sEnd, text: sText });
      }
      const wordList = (s as { word_list?: unknown })?.word_list;
      if (!Array.isArray(wordList)) continue;
      for (const w of wordList) {
        const word = String((w as { word?: unknown })?.word ?? '').trim();
        if (!word) continue;
        const start = msToSec((w as { start_time?: unknown })?.start_time);
        const end = msToSec((w as { end_time?: unknown })?.end_time);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          words.push({ word, start, end });
        }
      }
    }
  }
  return { text, words, segments };
}

/**
 * 状态分类（官方错误码表，响应 JSON `code` 字段；HTTP 层失败时可能无 code）：
 * - success：`0`（静音音频同为 0 + 空文本，由调用方按空结果成功处理）
 * - auth：`4002` 鉴权失败（SecretID/SecretKey/签名/时间偏差 >3 分钟）→ 不重试
 * - retriable：`4006` 并发超限、`4008` 请求排队超时、`4009` 内部超时、
 *   `5001/5002/5003` 服务端偶发（官方明示可重试）、HTTP 429/5xx
 * - fatal：`4001` 参数、`4003` 未开通、`4004` 额度耗尽、`4005` 欠费、`4007` 解码失败、
 *   `4010-4012` 音频不合规、其余未知码 → 不重试、明确报错
 */
export type TencentCodeClass = 'success' | 'auth' | 'retriable' | 'fatal';

const TENCENT_RETRIABLE_CODES = new Set([4006, 4008, 4009, 5001, 5002, 5003]);

export function classifyTencentCode(
  httpStatus: number,
  code?: number | string | null,
): TencentCodeClass {
  const numeric = Number(String(code ?? '').trim());
  const hasCode =
    code !== null && code !== undefined && Number.isFinite(numeric);
  if (hasCode) {
    if (numeric === 0) return 'success';
    if (numeric === 4002) return 'auth';
    if (TENCENT_RETRIABLE_CODES.has(numeric)) return 'retriable';
  }
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) {
    return 'retriable';
  }
  return 'fatal';
}

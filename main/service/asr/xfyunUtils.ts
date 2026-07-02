/**
 * 讯飞「录音文件转写大模型」（`office-api-ist-dx.iflyaisol.com/v2`）的
 * 纯工具（无网络 / fs / electron，node:crypto 仅做本地签名），便于 test:engines 单测。
 *
 * 鉴权：非空参数按名 ASCII 排序、值经 Java URLEncoder 兼容编码拼 baseString →
 * HMAC-SHA1(APISecret) → base64，放 `signature` 请求头。baseString 与最终请求
 * 查询串完全一致（零编码歧义，对齐 tencentUtils 的做法）。
 * 凭据映射（实测确认）：控制台 APPID→appId、APIKey→accessKeyId、APISecret→accessKeySecret。
 */
import crypto from 'crypto';
import type { AsrSegment, AsrWord } from './types';

export const XFYUN_API_HOST = 'office-api-ist-dx.iflyaisol.com';
export const XFYUN_UPLOAD_PATH = '/v2/upload';
export const XFYUN_GET_RESULT_PATH = '/v2/getResult';

/** 语种档位（models 承载）：autodialect=中英+202 方言；autominor=37 语种（需人工对接开通）。 */
export type XfyunTier = 'autodialect' | 'autominor';

/** 档位归一：仅 'autominor' 识别为多语种档，其余（含空/历史值）一律按默认 autodialect。 */
export function normalizeXfyunTier(model: string | undefined): XfyunTier {
  return String(model ?? '')
    .trim()
    .toLowerCase() === 'autominor'
    ? 'autominor'
    : 'autodialect';
}

/** autodialect 档支持的任务原语言（中英 + 202 方言免切；粤语在方言列表内）。 */
const XFYUN_DIALECT_LANGS = new Set(['auto', 'zh', 'zh-hant', 'yue', 'en']);

/**
 * autominor 档支持的任务原语言：官方 37 语种（中文、英文、日、韩、俄、法、西、阿、德、
 * 泰、越、印地、葡、意、马来、印尼、菲律宾、土、希腊、捷克、乌尔都、孟加拉、泰米尔、
 * 乌克兰、哈萨克、乌兹别克、波兰、蒙、斯瓦西里、豪撒、波斯、荷兰、瑞典、罗马尼亚、
 * 保加利亚、维、藏）映射 ISO-639-1（fil/tl 同菲律宾语；zh-hant 按中文）。
 */
const XFYUN_MINOR_LANGS = new Set([
  'auto',
  'zh',
  'zh-hant',
  'en',
  'ja',
  'ko',
  'ru',
  'fr',
  'es',
  'ar',
  'de',
  'th',
  'vi',
  'hi',
  'pt',
  'it',
  'ms',
  'id',
  'fil',
  'tl',
  'tr',
  'el',
  'cs',
  'ur',
  'bn',
  'ta',
  'uk',
  'kk',
  'uz',
  'pl',
  'mn',
  'sw',
  'ha',
  'fa',
  'nl',
  'sv',
  'ro',
  'bg',
  'ug',
  'bo',
]);

export type XfyunLanguageSupport = 'ok' | 'switch-tier' | 'unsupported';

/**
 * 「档位 × 任务原语言」上传前守卫（识别语言免切自动，原语言不上行）：
 * - ok：放行；
 * - switch-tier：当前档不支持、另一档支持（双向：如 ja 需 autominor、yue 需 autodialect），
 *   提示切档（autominor 方向附带开通提示）；
 * - unsupported：讯飞两档均不支持（继续上传只会产出乱码还照常计费）。
 * auto（自动识别）对两档都合法——档位本身即免切自动识别。
 */
export function resolveXfyunLanguageSupport(
  model: string | undefined,
  language: string | undefined,
): XfyunLanguageSupport {
  const tier = normalizeXfyunTier(model);
  const lang =
    String(language ?? '')
      .trim()
      .toLowerCase() || 'auto';
  const allowed =
    tier === 'autominor' ? XFYUN_MINOR_LANGS : XFYUN_DIALECT_LANGS;
  const other = tier === 'autominor' ? XFYUN_DIALECT_LANGS : XFYUN_MINOR_LANGS;
  if (allowed.has(lang)) return 'ok';
  if (other.has(lang)) return 'switch-tier';
  return 'unsupported';
}

/**
 * dateTime 参数：本地时区 `yyyy-MM-dd'T'HH:mm:ss±HHmm`（如 2026-07-02T22:30:32+0800）。
 * 服务端校验请求时效（code 100008），调用方须每次请求（含重试与每次轮询）重新生成并重签。
 */
export function buildXfyunDateTime(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const tzMin = -date.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const tzAbs = Math.abs(tzMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(tzAbs / 60))}${pad(tzAbs % 60)}`
  );
}

const RANDOM_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * signatureRandom：16 位大小写字母+数字随机串。同一订单的 upload 与其后所有
 * getResult 必须复用同一个（官方要求「确保请求关联性」，实测复用可用）。
 */
export function buildXfyunRandom(length = 16): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += RANDOM_CHARS[crypto.randomInt(RANDOM_CHARS.length)];
  }
  return out;
}

/**
 * Java URLEncoder.encode 兼容编码（官方签名示例为 Java TreeMap + URLEncoder）：
 * 空格→`+`，保留 `A-Za-z0-9 . - * _`，其余转 %XX——在 encodeURIComponent 基础上
 * 补齐 `! ' ( ) ~` 的差异转义。
 */
export function javaUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/!/g, '%21')
    .replace(/~/g, '%7E')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * 过滤空值 → 按参数名 ASCII 排序（等价 Java TreeMap 自然序）→ `k=编码(v)` 以 `&` 拼接。
 * 产物既是签名 baseString 又是最终请求查询串。
 */
export function buildXfyunQuery(
  params: Record<string, string | undefined>,
): string {
  return Object.keys(params)
    .filter((key) => {
      const v = params[key];
      return v !== undefined && v !== null && String(v) !== '';
    })
    .sort()
    .map((key) => `${key}=${javaUrlEncode(String(params[key]))}`)
    .join('&');
}

/** signature = Base64(HmacSHA1(baseString, APISecret))，放 `signature` 请求头。 */
export function signXfyunRequest(apiSecret: string, query: string): string {
  return crypto
    .createHmac('sha1', Buffer.from(apiSecret, 'utf8'))
    .update(Buffer.from(query, 'utf8'))
    .digest('base64');
}

/**
 * 上传文件名：`audio.<真实扩展名>`——后缀决定服务端格式识别必须保真；
 * 丢弃真实文件名（中文/特殊字符会扩大 URL 编码歧义面）。未知/缺失回落 wav。
 */
export function xfyunFileNameFromPath(filePath: string): string {
  const ext = String(filePath ?? '')
    .split('.')
    .pop()
    ?.toLowerCase()
    ?.trim();
  if (!ext || /[\\/]/.test(ext)) return 'audio.wav';
  return `audio.${ext}`;
}

/**
 * 响应码分类（code 为字符串形态如 '000000'；HTTP 层失败时可能无 code）：
 * - success：`000000`
 * - auth：`000002` APIKey 不存在/被禁、`100009` 签名错误（APISecret）、
 *   `100008` 请求时间超限（系统时间偏差）、`100007` 权限错误（服务未开通/未授权）→ 不重试
 * - retriable：`100012` 频率超限、`999999` 未知异常、HTTP 429/5xx
 * - fatal：其余（参数/订单/额度类）→ 不重试、明确报错
 * 订单进行态（`100013` 订单未完成）与订单失效（`100001`/`100037`/`100039`）
 * 由轮询循环单独语义化处理，不进本分类。
 */
export type XfyunCodeClass = 'success' | 'auth' | 'retriable' | 'fatal';

const XFYUN_AUTH_CODES = new Set(['000002', '100007', '100008', '100009']);
const XFYUN_RETRIABLE_CODES = new Set(['100012', '999999']);

export function classifyXfyunCode(
  httpStatus: number,
  code?: string | number | null,
): XfyunCodeClass {
  const c = String(code ?? '').trim();
  if (c) {
    if (c === '000000') return 'success';
    if (XFYUN_AUTH_CODES.has(c)) return 'auth';
    if (XFYUN_RETRIABLE_CODES.has(c)) return 'retriable';
    return 'fatal';
  }
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) {
    return 'retriable';
  }
  return 'fatal';
}

/** 轮询遇这些 code 视为「订单不存在/非法」：续查场景清持久化记录回落新上传。 */
const XFYUN_ORDER_GONE_CODES = new Set(['100001', '100037', '100039']);

export function isXfyunOrderGone(code?: string | number | null): boolean {
  return XFYUN_ORDER_GONE_CODES.has(String(code ?? '').trim());
}

/**
 * 订单 failType → 可行动错误描述；返回 null 表示无异常。
 * failType=6（静音文件）不在此处理——调用方按「空结果成功」语义返回空字幕。
 */
export function mapXfyunFailType(failType: unknown): string | null {
  const n = Number(failType);
  if (!Number.isFinite(n) || n === 0) return null;
  switch (n) {
    case 1:
      return 'audio upload failed (failType 1)';
    case 2:
      return 'audio transcode failed, check the file is not corrupted or encrypted (failType 2)';
    case 3:
      return 'audio recognition failed (failType 3)';
    case 4:
      return 'audio duration exceeds the 5-hour limit (failType 4)';
    case 5:
      return 'audio duration check failed (failType 5)';
    default:
      return `transcription failed (failType ${n})`;
  }
}

/** 词属性：n=正常词 s=顺滑词 p=标点 g=分段标记。 */
interface XfyunToken {
  w: string;
  wp: string;
}

/**
 * 从 getResult 的 `orderResult`（JSON 字符串或已解析对象）提取 { text, words, segments }：
 * - 取 `lattice`（顺滑后结果，恒存在；`lattice2` 需开权限，不依赖）；
 * - `json_1best` 兼容「字符串（实测形态，需二次 parse）/ 对象（文档示例形态）」；
 * - 句级：`st.bg/ed`（毫秒）→ AsrSegment（秒）；句文本按序拼接 wp∈{n,p}（s/g 跳过）；
 * - 词级：wp=n → AsrWord，时间 = (bg + wb×10)/1000 秒（wb/we 为相对句首的 10ms 帧）；
 *   wp=p 标点内联并入前一词尾（讯飞标点自带位置，比整段回贴更准；无前词的孤立标点仅进句文本）；
 * - 防御：任何一层结构不符跳过该元素（不误贴、不中断），全部失败退化为空结果。
 */
export function extractXfyunResult(orderResult: unknown): {
  text: string;
  words: AsrWord[];
  segments: AsrSegment[];
} {
  const words: AsrWord[] = [];
  const segments: AsrSegment[] = [];

  let parsed: unknown = orderResult;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { text: '', words, segments };
    }
  }
  const lattice = (parsed as { lattice?: unknown })?.lattice;
  if (!Array.isArray(lattice)) return { text: '', words, segments };

  for (const item of lattice) {
    let best: unknown = (item as { json_1best?: unknown })?.json_1best;
    if (typeof best === 'string') {
      try {
        best = JSON.parse(best);
      } catch {
        continue;
      }
    }
    const st = (best as { st?: unknown })?.st as
      | {
          bg?: unknown;
          ed?: unknown;
          rt?: unknown;
        }
      | undefined;
    if (!st) continue;
    const bgMs = Number(st.bg);
    const edMs = Number(st.ed);
    if (!Number.isFinite(bgMs) || !Number.isFinite(edMs)) continue;

    let sentence = '';
    // 拉丁词间补空格（英/法/德等，autominor 档常见）：上一字符与本词首字符均为
    // ASCII 可见字符时插空格；CJK 前后不加（对齐实测「包含English单词」的中英混排形态）。
    const appendToken = (token: string) => {
      if (
        sentence &&
        /[\x21-\x7e]$/.test(sentence) &&
        /^[A-Za-z0-9]/.test(token)
      ) {
        sentence += ' ';
      }
      sentence += token;
    };
    const rt = Array.isArray(st.rt) ? st.rt : [];
    for (const r of rt) {
      const ws = (r as { ws?: unknown })?.ws;
      if (!Array.isArray(ws)) continue;
      for (const w of ws) {
        const cw = (w as { cw?: unknown })?.cw;
        const first = (Array.isArray(cw) ? cw[0] : undefined) as
          | XfyunToken
          | undefined;
        const token = String(first?.w ?? '');
        const wp = String(first?.wp ?? '');
        if (wp === 's' || wp === 'g' || !token) continue;
        if (wp === 'p') {
          sentence += token;
          // 标点内联并入前一词尾（讯飞标点总跟随句内前词；无前词的孤立标点仅进句文本）。
          if (words.length > 0) {
            words[words.length - 1].word += token;
          }
          continue;
        }
        // wp=n 正常词
        appendToken(token);
        const wb = Number((w as { wb?: unknown })?.wb);
        const we = Number((w as { we?: unknown })?.we);
        if (Number.isFinite(wb) && Number.isFinite(we)) {
          words.push({
            word: token,
            start: (bgMs + wb * 10) / 1000,
            end: (bgMs + we * 10) / 1000,
          });
        }
      }
    }
    const sText = sentence.trim();
    if (sText) {
      segments.push({ start: bgMs / 1000, end: edMs / 1000, text: sText });
    }
  }

  const text = segments.map((s) => s.text).join(' ');
  return { text, words, segments };
}

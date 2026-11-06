/**
 * 谷歌免费翻译 chrome 通道（translate_a/t，client=dict-chrome-ex）的纯函数：
 * 请求串构造、切块、响应解析、异常流量页识别。不做 I/O，也不写日志。
 *
 * 协议事实来自本机实测与公开讨论，实现不参考任何第三方代码；证据与取舍见
 * openspec/changes/add-google-chrome-client-lane/design.md。
 */

export const CHROME_ENDPOINT = 'https://translate.googleapis.com/translate_a/t';
export const CHROME_CLIENT = 'dict-chrome-ex';
/** 单条文本发送前的字符上限（与 gtx 通道一致）。 */
export const MAX_TEXT_LENGTH = 5000;
/** 一个请求的查询串上限（含 client、sl、tl）；实测 16 KB 的 GET 也能通过，这里取约三分之一。 */
export const MAX_QUERY_BYTES = 6000;
/** 一个请求最多携带的 q 个数。 */
export const MAX_ITEMS_PER_REQUEST = 50;

// 不带 u 标志：按 UTF-16 码元匹配，才能找出落单的代理项。
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const ABUSE_MARKERS = ['unusual traffic', 'automated queries', '/sorry/'];
const MAX_BODY_SCAN = 100_000;

/**
 * 文本在发送前的样子：截断到 MAX_TEXT_LENGTH 且不把一个 emoji 劈成两半；
 * 落单的代理项（损坏的字幕文件里会有）换成 U+FFFD，否则编码会抛 URIError。
 */
export function prepareText(text: string): string {
  let cut = text;
  if (text.length > MAX_TEXT_LENGTH) {
    cut = text.slice(0, MAX_TEXT_LENGTH);
    const last = cut.charCodeAt(cut.length - 1);
    const next = text.charCodeAt(MAX_TEXT_LENGTH);
    const splitsPair =
      last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    if (splitsPair) cut = cut.slice(0, -1);
  }
  return cut.replace(LONE_SURROGATE, '\uFFFD');
}

/**
 * `client=dict-chrome-ex&sl=…&tl=…&q=…&q=…`（不含开头的 `?`）。
 * axios 会把数组序列化成 `q[]=`，服务端不认，所以查询串在这里手工构造。
 */
export function buildChromeQuery(
  texts: string[],
  sl: string,
  tl: string,
): string {
  const params = new URLSearchParams();
  params.append('client', CHROME_CLIENT);
  params.append('sl', sl);
  params.append('tl', tl);
  for (const text of texts) params.append('q', prepareText(text));
  return params.toString();
}

export interface ChromeChunk {
  /** 这些文本在原列表里的位置，保持原顺序。 */
  indexes: number[];
  /** 实际发送的文本（已截断、已处理落单代理项）。 */
  texts: string[];
}

/** `&q=<编码后文本>` 占用的字节数；查询串编码后全是 ASCII，字符数即字节数。 */
function queryCost(text: string): number {
  return 1 + new URLSearchParams([['q', text]]).toString().length;
}

/**
 * 把一批文本切成若干请求：每块最多 MAX_ITEMS_PER_REQUEST 个 q，查询串最多
 * MAX_QUERY_BYTES 字节；编码后自己就超预算的单条单独成块，不拆开。空串与全空白条目
 * 不进请求，调用方按位置原样放回。
 */
export function planChromeChunks(
  list: string[],
  sl: string,
  tl: string,
): ChromeChunk[] {
  const base = buildChromeQuery([], sl, tl).length;
  const chunks: ChromeChunk[] = [];
  let current: ChromeChunk | undefined;
  let size = 0; // only meaningful while `current` exists

  list.forEach((raw, index) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const text = prepareText(raw);
    const cost = queryCost(text);
    if (
      current &&
      (current.texts.length >= MAX_ITEMS_PER_REQUEST ||
        size + cost > MAX_QUERY_BYTES)
    ) {
      chunks.push(current);
      current = undefined;
    }
    if (!current) {
      current = { indexes: [], texts: [] };
      size = base;
    }
    current.indexes.push(index);
    current.texts.push(text);
    size += cost;
  });
  if (current) chunks.push(current);
  return chunks;
}

/**
 * 每个成员把对方的字段声明为 `undefined`：仓库以 `strict: false` 编译，`ok` 无法收窄联合类型，
 * 所以 `reason` 与 `translations` 在两个成员上都必须可读。
 */
export type ChromeParseResult =
  | {
      ok: true;
      translations: string[];
      reason?: undefined;
      emptyItems?: undefined;
    }
  | {
      ok: false;
      reason: string;
      emptyItems: number;
      translations?: undefined;
    };

/**
 * 合法响应是长度等于 q 个数的数组，元素是字符串（显式 sl），或首项为字符串的数组
 * （sl=auto 时的 [译文, 检测语言]）。条数不符、形状不符或任何一项译文为空都是协议异常，
 * 绝不返回部分结果。失败原因只含计数，不含响应内容。
 *
 * 响应的每一项都对应一条非空白输入（空白条目不进请求），而服务对无法翻译的行
 * （♪、...、{\an8}）返回原文，所以空译文是降级答案而不是结果：2026-10-15 的实网冒烟里
 * 有一批 20 条的响应出现过 8 项空串，其余 12 项正常。
 *
 * 被拒绝时 `emptyItems` 是空译文的个数：只有这一类拒绝（大于 0）是偶发的降级答案，值得
 * 用同样的请求再问一次；条数、形状与非数组的拒绝是结构性的，`emptyItems` 为 0。
 */
export function parseChromeResponse(
  data: unknown,
  expected: number,
): ChromeParseResult {
  if (!Array.isArray(data)) {
    return { ok: false, reason: 'unexpected response', emptyItems: 0 };
  }
  if (data.length !== expected) {
    return {
      ok: false,
      reason: `expected ${expected} translations, got ${data.length}`,
      emptyItems: 0,
    };
  }
  const translations: string[] = [];
  for (const item of data) {
    if (typeof item === 'string') {
      translations.push(item);
    } else if (Array.isArray(item) && typeof item[0] === 'string') {
      translations.push(item[0]);
    } else {
      return { ok: false, reason: 'unexpected item shape', emptyItems: 0 };
    }
  }
  const empty = translations.filter((translation) => !translation.trim());
  if (empty.length > 0) {
    return {
      ok: false,
      reason: `${empty.length} of ${expected} translations are empty`,
      emptyItems: empty.length,
    };
  }
  return { ok: true, translations };
}

/**
 * 是不是 Google 的「异常流量」拦截页：429 或 403，且响应体含标记之一（不区分大小写；
 * 响应体可能是字符串，也可能已被 axios 解析成对象）。其它情况一律按普通失败处理。
 */
export function isAbusePage(
  status: number | undefined,
  body: unknown,
): boolean {
  if (status !== 429 && status !== 403) return false;
  let text: string;
  if (typeof body === 'string') {
    text = body;
  } else if (body === undefined || body === null) {
    return false;
  } else if (Buffer.isBuffer(body)) {
    text = body.toString('utf8');
  } else {
    try {
      text = JSON.stringify(body) ?? '';
    } catch {
      return false;
    }
  }
  const lower = text.slice(0, MAX_BODY_SCAN).toLowerCase();
  return ABUSE_MARKERS.some((marker) => lower.includes(marker));
}

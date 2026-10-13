/**
 * 有道免费翻译的字幕文本处理（纯函数，无网络、无状态）。
 *
 * 机翻会破坏字幕里的 HTML 标签、ASS 覆盖标签、♪ 音符、对白破折号与方括号音效，
 * 所以发送前先把每行首尾的标记剥离并记录，译后按原位置还原；被换行截断的句子
 * 合并成一个段落一起翻译，避免译成两个残句。整套规则见
 * openspec/changes/add-youdao-free-translator/design.md 的 D4、D5。
 */

export interface ParagraphPlan {
  /** 发送给服务端的单行文本，不含 `\n` */
  send: string;
  /** 译后加回译文前面的标记（行首标签、音符、破折号等） */
  lead: string;
  /** 译后加回译文后面的标记 */
  trail: string;
  /** 整行被括号包裹时的括号类型，译后包回 */
  wrap?: { open: string; close: string };
}

export type CueItem =
  | { type: 'raw'; text: string }
  | { type: 'para'; index: number };

export interface CuePlan {
  /** 按条目内行序排列；`raw` 原样输出，`para` 取对应段落译文 */
  items: CueItem[];
  paragraphs: ParagraphPlan[];
}

interface Tag {
  /** 配对标识；null 表示不参与配对（定位、颜色、<br> 等） */
  name: string | null;
  open: boolean;
}

interface Part {
  text: string;
  tag?: Tag;
  dropped?: boolean;
}

interface ParsedLine {
  raw: string;
  skip: boolean;
  leadParts: Part[];
  trailParts: Part[];
  bodyTags: Tag[];
  body: string;
  hasDash: boolean;
  wrap?: { open: string; close: string };
}

const LETTER = /\p{L}/u;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const HTML_TAG_SOURCE = '<\\/?[a-zA-Z][^<>]*>';
const ASS_BLOCK_SOURCE = '\\{\\\\[^{}]*\\}';
const LEAD_PART = new RegExp(
  `^(?:\\s+|${HTML_TAG_SOURCE}|${ASS_BLOCK_SOURCE}|[♪♫]|[-–—]+\\s*)`,
);
const TRAIL_PART = new RegExp(
  `(?:\\s+|${HTML_TAG_SOURCE}|${ASS_BLOCK_SOURCE}|[♪♫])$`,
);
const INLINE_TAG = new RegExp(`${HTML_TAG_SOURCE}|${ASS_BLOCK_SOURCE}`, 'g');
const HTML_TAG = new RegExp(`^${HTML_TAG_SOURCE}$`);
const PAIRABLE_HTML = new Set(['i', 'b', 'u', 's', 'font']);
const ASS_TOGGLE = /^\{\\([ibus])([01])\}$/;
const SENTENCE_END = /[.?!…。！？‼⁇]$/;
const CLOSING_CHARS = /[\s"'”’»」』）)\]]+$/;

function classifyTag(raw: string): Tag {
  const ass = raw.match(ASS_TOGGLE);
  if (ass) return { name: `ass:${ass[1]}`, open: ass[2] === '1' };
  if (HTML_TAG.test(raw)) {
    const name = raw.match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)/)![1].toLowerCase();
    if (PAIRABLE_HTML.has(name) && !raw.endsWith('/>')) {
      return { name, open: !raw.startsWith('</') };
    }
  }
  return { name: null, open: true };
}

function endsSentence(body: string): boolean {
  return SENTENCE_END.test(body.replace(CLOSING_CHARS, ''));
}

function joinBodies(left: string, right: string): string {
  const a = left.slice(-1);
  const b = right.slice(0, 1);
  return CJK.test(a) || CJK.test(b) ? left + right : `${left} ${right}`;
}

function parseLine(raw: string): ParsedLine {
  let rest = raw;
  const leadParts: Part[] = [];
  let hasDash = false;
  for (;;) {
    const match = rest.match(LEAD_PART);
    if (!match) break;
    const piece = match[0];
    const part: Part = { text: piece };
    if (/^[-–—]/.test(piece)) hasDash = true;
    else if (/^[<{]/.test(piece)) part.tag = classifyTag(piece);
    leadParts.push(part);
    rest = rest.slice(piece.length);
  }

  const trailParts: Part[] = [];
  for (;;) {
    const match = rest.match(TRAIL_PART);
    if (!match) break;
    const piece = match[0];
    const part: Part = { text: piece };
    if (/^[<{]/.test(piece)) part.tag = classifyTag(piece);
    trailParts.unshift(part);
    rest = rest.slice(0, rest.length - piece.length);
  }

  const bodyTags: Tag[] = [];
  let body = rest
    .replace(INLINE_TAG, (piece) => {
      const tag = classifyTag(piece);
      bodyTags.push(tag);
      // emphasis tags vanish; anything else (e.g. <br>) may separate words
      return tag.name ? '' : ' ';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  let wrap: ParsedLine['wrap'];
  const bracket = body.match(/^\[([^[\]]*)\]$/) || body.match(/^\(([^()]*)\)$/);
  if (bracket) {
    wrap = { open: body[0], close: body[body.length - 1] };
    body = bracket[1].trim();
  }

  return {
    raw,
    skip: !LETTER.test(body),
    leadParts,
    trailParts,
    bodyTags,
    body,
    hasDash,
    wrap,
  };
}

/** 把一个字幕条目拆成待翻译段落与还原所需的信息。 */
export function planCue(cue: string): CuePlan {
  const lines = cue.split(/\r?\n/).map(parseLine);

  // Group lines into paragraphs; lines without letters stay raw and break paragraphs.
  type Group = { lines: ParsedLine[]; closed: boolean };
  const layout: Array<ParsedLine | Group> = [];
  let current: Group | null = null;
  for (const line of lines) {
    if (line.skip) {
      current = null;
      layout.push(line);
      continue;
    }
    if (!current || line.hasDash || line.wrap || current.closed) {
      current = { lines: [line], closed: false };
      layout.push(current);
    } else {
      current.lines.push(line);
    }
    current.closed = Boolean(line.wrap) || endsSentence(line.body);
  }

  // Pair emphasis tags across the whole cue. A tag we will keep loses its
  // partner when the partner is removed (mid-line, or inside a merged
  // paragraph), so the pair is dropped together.
  const tokens: Array<{ tag: Tag; part?: Part; kept: boolean }> = [];
  for (const entry of layout) {
    if ('raw' in entry) {
      const line = entry;
      for (const part of [...line.leadParts, ...line.trailParts]) {
        if (part.tag) tokens.push({ tag: part.tag, kept: true });
      }
      continue;
    }
    entry.lines.forEach((line, index) => {
      const first = index === 0;
      const last = index === entry.lines.length - 1;
      for (const part of line.leadParts) {
        if (part.tag) tokens.push({ tag: part.tag, part, kept: first });
      }
      for (const tag of line.bodyTags) tokens.push({ tag, kept: false });
      for (const part of line.trailParts) {
        if (part.tag) tokens.push({ tag: part.tag, part, kept: last });
      }
    });
  }
  const stacks = new Map<string, Array<(typeof tokens)[number]>>();
  for (const token of tokens) {
    const { name, open } = token.tag;
    if (!name) continue;
    if (open) {
      const stack = stacks.get(name) || [];
      stack.push(token);
      stacks.set(name, stack);
      continue;
    }
    const opener = stacks.get(name)?.pop();
    if (!opener || opener.kept === token.kept) continue;
    const keptSide = opener.kept ? opener : token;
    if (keptSide.part) keptSide.part.dropped = true;
  }

  const items: CueItem[] = [];
  const paragraphs: ParagraphPlan[] = [];
  for (const entry of layout) {
    if ('raw' in entry) {
      items.push({ type: 'raw', text: entry.raw });
      continue;
    }
    const first = entry.lines[0];
    const last = entry.lines[entry.lines.length - 1];
    const visible = (parts: Part[]) =>
      parts
        .filter((part) => !part.dropped)
        .map((part) => part.text)
        .join('');
    paragraphs.push({
      send: entry.lines
        .map((line) => line.body)
        .reduce((acc, body) => joinBodies(acc, body)),
      lead: visible(first.leadParts),
      trail: visible(last.trailParts),
      wrap: first.wrap,
    });
    items.push({ type: 'para', index: paragraphs.length - 1 });
  }
  return { items, paragraphs };
}

/** 用段落译文还原条目；译文数组与 `plan.paragraphs` 一一对应。 */
export function restoreCue(plan: CuePlan, translations: string[]): string {
  return plan.items
    .map((item) => {
      if (item.type === 'raw') return item.text;
      const paragraph = plan.paragraphs[item.index];
      let translated = (translations[item.index] ?? '').trim();
      if (/[-–—]/.test(paragraph.lead)) {
        // the dash is restored from the source; don't stack another one
        translated = translated.replace(/^(?:[-–—]+\s*)+/, '');
      }
      if (paragraph.wrap) {
        translated = paragraph.wrap.open + translated + paragraph.wrap.close;
      }
      return paragraph.lead + translated + paragraph.trail;
    })
    .join('\n');
}

/**
 * 回显比较用的归一化：NFKC（服务端会把半角括号数字回显成全角）、
 * 去掉空白与标点符号。
 */
export function normalizeEcho(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
}

const FULL_WIDTH_PUNCTUATION: Record<string, string> = {
  ',': '，',
  '?': '？',
  '!': '！',
  ':': '：',
  ';': '；',
};

/** 中文目标译文规范化：去末尾换行、汉字相邻的半角标点转全角、全角数字转半角。 */
export function normalizeChineseTranslation(value: string): string {
  return value
    .replace(/[\r\n]+$/, '')
    .replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    )
    .replace(
      /(?<=\p{Script=Han})[,?!:;]|[,?!:;](?=\p{Script=Han})/gu,
      (mark) => FULL_WIDTH_PUNCTUATION[mark],
    );
}

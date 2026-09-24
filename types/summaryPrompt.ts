/**
 * 产品级通读摘要提示词。
 *
 * 与翻译服务商的 systemPrompt（src/tr JSON 协议）物理分离：摘要服务可以
 * 不是翻译服务，且摘要输出是纯文本，不能走回显协议。
 *
 * settings.summaryPrompt 存用户改写版；空 / 缺省 / 空白回落本出厂稿，
 * 不做首启动写死迁移，避免把后续出厂更新锁进用户商店。
 */

export const defaultSummaryPrompt = `# Role: 字幕分析助手
你是字幕分析助手。下面是当前\${sourceLanguage}字幕（每行：id<TAB>原文）。

# Attention
请用\${targetLanguage}输出「翻译用摘要」（供后续分批翻译时作为语境参考），不得超过 400 字，必须包含：

1. **内容概述**：当前这段字幕在讲什么，涉及什么话题或场景。
2. **关键说话人与指称**：当前字幕中出现的说话人、被提及者，以及他们之间的称呼方式。仅限当前字幕内出现的，不要补写未见内容。
3. **语气基调与未决信息**：说话人的语气特征（正式/随意/讽刺/紧张等），以及在当前批次中未交代完、可能影响后续翻译连贯性的信息。
4. **称谓、专有名词及潜在歧义**：点出容易混的叫法或未决指称，**仍用源字幕里的写法**。若篇幅紧张，本条可压缩。

专名规则（摘要是给后续翻译批次看的语境，不是译文本身）：
- 人名、地名、建制、称谓一律使用源字幕中的写法，以便和后续各批原文对齐。
- 若 instructions 中另附专有名词表：不要发明表外译名；**不要**把摘要里的专名改写成表内译文。译名由后续翻译批次的词库注入负责。
- 不要标注「（临时译法，待确认）」，不要另造一套中文叫法。

# 输出格式要求

1. 输入是当前字幕清单，每行 \`id<TAB>原文\`；无时间码；原文中的换行已压成 \` / \`。
2. 只输出摘要正文。
3. 不要 JSON，不要条目译文，不要 Markdown 标题堆砌，不要写成观众导视或影评。
4. 不要把相邻条目逐条翻译；这不是翻译任务。
5. 若篇幅紧张，优先保留第 1–3 条，压缩或省略第 4 条。

# Examples

Input:
\`\`\`
0	Welcome to China
1	China is a beautiful country
\`\`\`

Output:
开场欢迎听众来到中国，并称赞其风光。说话人面向听众，语气热情、介绍性。专名 China 保留原文；欢迎套语前后保持一致。
`;

/** 文件总 cue 数下限；再短压缩没有信息增益。 */
export const SUMMARY_MIN_CUES = 20;

/** 预计批次下限；单批时模型已看见全文。 */
export const SUMMARY_MIN_BATCHES = 2;

/** 与 refineProvider 同构的「跟随翻译服务」哨兵。 */
export const FOLLOW_TRANSLATION_PROVIDER = 'follow-translation';

export const SUMMARY_GLOSSARY_HEADING =
  '## 专有名词（对照用：摘要保持源文写法，不要改写成表内译文）';

export const SUMMARY_BLOCK_HEADING =
  '## 本集剧情摘要（翻译时请参考语境与人物状态，勿写入输出 JSON）';

export type SummaryErrorCode =
  | 'empty'
  | 'empty-after-think-strip'
  | 'skipped-trivial'
  | 'skipped-resume'
  | 'provider-unresolved'
  | 'provider-not-ai'
  | 'provider-unconfigured'
  | 'call-failed';

/** 出厂稿「不得超过 400 字」的运行时上限。CJK 按码点，其它语言按词。 */
export const SUMMARY_MAX_UNITS = 400;

const CJK_PRIMARY_SUBTAGS = new Set(['zh', 'ja', 'ko', 'yue']);

/**
 * 词边界分词器。结构化类型 + 运行时探测，不依赖 TS lib 的 Intl.Segmenter 声明。
 * 与 subtitleSegmentation 的词边界分词器同一写法。
 */
interface SummaryWordSegment {
  segment: string;
  index: number;
  isWordLike?: boolean;
}
interface SummaryWordSegmenter {
  segment(input: string): Iterable<SummaryWordSegment>;
}
type SummarySegmenterCtor = new (
  locale?: string,
  options?: { granularity?: 'word' | 'grapheme' | 'sentence' },
) => SummaryWordSegmenter;

const segmenterCache = new Map<string, SummaryWordSegmenter>();

/** 词边界分词器。构造失败或运行时没有 Segmenter 时返回 null，调用方按空白切分。 */
export function summaryWordSegmenter(locale: string): SummaryWordSegmenter | null {
  const ctor =
    typeof Intl !== 'undefined'
      ? (Intl as { Segmenter?: SummarySegmenterCtor }).Segmenter
      : undefined;
  if (typeof ctor !== 'function') return null;
  const key = locale || '';
  const cached = segmenterCache.get(key);
  if (cached) return cached;
  try {
    const created = new ctor(locale || undefined, { granularity: 'word' });
    segmenterCache.set(key, created);
    return created;
  } catch {
    return null;
  }
}

/** 主子标签（小写，按 '-' 或 '_' 切开的第一段）属于中日韩或粤语。 */
export function isCjkSummaryTarget(targetLang: string): boolean {
  const primary = String(targetLang || '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return CJK_PRIMARY_SUBTAGS.has(primary);
}

export function isSummaryWhitespace(ch: string): boolean {
  return /^\s$/.test(ch);
}

/** 从 index 取出一个 Unicode 码点，不拆开代理对。 */
export function nextSummaryCodePoint(
  text: string,
  index: number,
): { ch: string; end: number } {
  const cp = text.codePointAt(index) as number;
  const width = cp > 0xffff ? 2 : 1;
  return { ch: text.slice(index, index + width), end: index + width };
}

function countNonSpaceCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const step = nextSummaryCodePoint(text, i);
    if (!isSummaryWhitespace(step.ch)) count += 1;
    i = step.end;
  }
  return count;
}

function countWordsFallback(text: string): number {
  const parts = text.trim().match(/\S+/g);
  return parts ? parts.length : 0;
}

function countWords(text: string, targetLang: string): number {
  const segmenter = summaryWordSegmenter(targetLang.trim());
  if (!segmenter) return countWordsFallback(text);
  let count = 0;
  const parts = Array.from(segmenter.segment(text));
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].isWordLike) count += 1;
  }
  return count;
}

/**
 * 摘要长度。
 * CJK 目标按 Unicode 码点计：先 trim，再去掉空白（含换行、全角空格）。
 * 换行不计入，避免排版把篇幅撑过上限；一个代理对算一个码点。
 * 其它目标按词计（Segmenter 的 isWordLike）。运行时没有 Segmenter 时按空白切分。
 */
export function measureSummary(text: string, targetLang: string): number {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 0;
  if (isCjkSummaryTarget(targetLang)) return countNonSpaceCodePoints(trimmed);
  return countWords(trimmed, targetLang);
}

/** 空 / 空白 / 非字符串一律回落出厂稿。 */
export function resolveSummaryPrompt(stored?: unknown): string {
  if (typeof stored !== 'string') return defaultSummaryPrompt;
  const trimmed = stored.trim();
  return trimmed || defaultSummaryPrompt;
}

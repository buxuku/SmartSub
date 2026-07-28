/**
 * AI 字幕精修（语义断句 + 字幕校正）· 类型与限长派生（openspec: add-ai-subtitle-refine）。
 *
 * 本目录为零 electron 依赖的纯逻辑层：协议编解码（protocol）、校验器（validator）、
 * 时间轴对齐（alignment）、分窗（windowing）、物理护栏（guards）均可被
 * `test:refine` 脚本直接编译运行。LLM 请求与管线编排在 `segmentationRunner.ts`
 * （依赖主进程环境）中，不属于纯逻辑层。
 */

import type { TokenTriple } from '../subtitleSegmentation';

/** 词级时间轴输入档位：word = 真实词级时间戳；segment = 仅有规则 cue（近似模式）。 */
export type RefineTier = 'word' | 'segment';

/**
 * 精修用的词单元（毫秒时间轴，与内置引擎 NativeToken 同构）：
 * start/end 为 null 表示该词时间不可信（对齐时并入相邻词，不作边界）。
 * p 为 ASR token 置信度（仅 builtin 提供），供校正遍低置信标注。
 */
export interface RefineWord {
  text: string;
  start: number | null;
  end: number | null;
  p?: number;
}

/** 精修阶段输入：规则断句结果恒为兜底；词级序列仅 Tier 'word' 存在。 */
export interface RefineInput {
  /** 规则断句产出的 cues（降级兜底 + Tier 'segment' 的重组输入）。 */
  cues: TokenTriple[];
  /** Tier 'word' 的词级序列（成句前的原始词单元）。 */
  words?: RefineWord[];
  tier: RefineTier;
}

/** 断句限长（随任务「字幕断句方式」派生，见 limitsFromCueOptions）。 */
export interface RefineLimits {
  /** 单条字幕显示宽度硬上限（CJK 记 2；护栏用）。Infinity = 用户选了「不限制长度」。 */
  maxWidth: number;
  /** LLM 断句遍的 CJK 段字数上限（提示词 + 校验用）。 */
  cjkCharLimit: number;
  /** LLM 断句遍的拉丁段词数上限（提示词 + 校验用）。 */
  latinWordLimit: number;
  /** 是否对 LLM 输出执行逐段限长校验（「不限制长度」时关闭，仅护栏兜底）。 */
  lengthCheckEnabled: boolean;
}

/** 词级时间轴 sidecar 文件（`<media>.words.json`）：供精修阶段与任务重试续跑消费。 */
export interface WordTimelineSidecar {
  version: 1;
  /** 产出引擎标识（builtin / fasterWhisper / cloud:<provider> …），仅诊断用。 */
  engine: string;
  words: RefineWord[];
}

/** 断句窗口：words 为窗口内词单元切片（Tier 'word'），cueRange 为 Tier 'segment' 的 cue 下标区间。 */
export interface SegmentationWindow {
  /** 窗口在全文中的序号（0 起），日志与进度用。 */
  index: number;
  /** 送给 LLM 的窗口原文（词文本原样拼接，仅折叠连续空白）。 */
  text: string;
  /** Tier 'word'：窗口覆盖的词切片。 */
  words?: RefineWord[];
  /** Tier 'segment'：窗口覆盖的 cue 下标（含首不含尾）。 */
  cueRange?: [number, number];
}

/** 对齐产物：cue 三元组 + （Tier 'word'）支撑该 cue 的词切片（护栏重切与低置信标注用）。 */
export interface AlignedCue {
  cue: TokenTriple;
  words?: RefineWord[];
}

const DEFAULT_MAX_WIDTH = 40;
const MIN_CJK_CHAR_LIMIT = 8;
const MIN_LATIN_WORD_LIMIT = 4;

/**
 * 由任务级宽度上限派生 LLM 断句限长（design D3）：
 *  - maxWidth 缺省（智能断句）→ 40（与 groupTokenCues DEFAULTS 一致）；
 *  - CJK 段字数 ≈ maxWidth/2 - 2（宽度语义 CJK 记 2，留 2 字标点余量，默认 40 → 18 字）；
 *  - 拉丁段词数 ≈ maxWidth/5（英文均词长 ~5，默认 40 → 8 词）；
 *  - 「不限制长度」（maxWidth = Infinity）→ 提示词仍给默认限长引导可读性，
 *    但关闭逐段限长校验（不因超长反馈重试，护栏也不硬切）。
 */
export function limitsFromCueOptions(options?: {
  maxWidth?: number;
}): RefineLimits {
  const rawWidth = options?.maxWidth;
  const unlimited = rawWidth === Number.POSITIVE_INFINITY;
  const maxWidth =
    rawWidth === undefined || !Number.isFinite(rawWidth) || rawWidth <= 0
      ? unlimited
        ? Number.POSITIVE_INFINITY
        : DEFAULT_MAX_WIDTH
      : rawWidth;
  const effective = Number.isFinite(maxWidth) ? maxWidth : DEFAULT_MAX_WIDTH;
  return {
    maxWidth,
    cjkCharLimit: Math.max(MIN_CJK_CHAR_LIMIT, Math.floor(effective / 2) - 2),
    latinWordLimit: Math.max(MIN_LATIN_WORD_LIMIT, Math.round(effective / 5)),
    lengthCheckEnabled: !unlimited,
  };
}

/** 规范化比对形态：去除全部空白（跨语言统一，`<br>` 位置换算与等值比对共用）。 */
export function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, '');
}

/** CJK 表意字符（含假名/谚文/全角字母数字）判定，与 subtitleSegmentation 的宽度语义对齐。 */
export function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xff10 && code <= 0xff19) ||
    (code >= 0xff21 && code <= 0xff3a) ||
    (code >= 0xff41 && code <= 0xff5a)
  );
}

/**
 * 窗口主导语言判定（限长维度选择用，与卡卡同策略）：
 * CJK 字符占实义字符 ≥ 30% 即按 CJK 限长——中英夹杂的中文口语里拉丁词常成串出现，
 * 阈值取低避免被英文术语拉偏。
 */
export function isMainlyCjk(text: string): boolean {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    if (isCjkChar(ch)) cjk += 1;
    else if (/[A-Za-z0-9]/.test(ch)) latin += 1;
  }
  const total = cjk + latin;
  if (total === 0) return false;
  return cjk / total >= 0.3;
}

/** 段内 CJK 字数（限长校验用：只数表意字符，不含标点/空白/拉丁）。 */
export function cjkCharCount(text: string): number {
  let n = 0;
  for (const ch of text) if (isCjkChar(ch)) n += 1;
  return n;
}

/** 段内拉丁词数（按空白切分的非空片段数）。 */
export function latinWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

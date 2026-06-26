/**
 * 方案 builtin-subtitle-timeline-0fork（不改上游 whisper.cpp）：内置引擎用 `max_len=1`
 * 让 addon 输出「每 token 一段」（带 token 级时间戳），再在 TS 侧：
 *   1) retimeTokensToSpeech：用语音边界把每个 token 贴回真实有声区间（还原段间停顿）；
 *   2) groupTokenCues：按停顿 / 句末标点 / 长度上限聚合成多条字幕。
 *
 * 输入即 addon 的 `result.transcription`：[startStr, endStr, tokenText][]，
 * 时间形如 `HH:MM:SS.mmm`（comma_in_time:false）。
 *
 * 本模块为纯函数（不依赖 electron / fs / 原生库），便于 test:engines 单测：
 * 故内联时间解析/格式化（不从 fileUtils 引入），并自带结构等价的 `SpeechSegment` 类型
 * （与 speechBoundary.SpeechSegment 结构一致，结构化兼容；不 import 以免把 electron 图拉进编译）。
 */
export type TokenTriple = [string, string, string];

/** 语音段 [start,end]（秒）。结构等价于 speechBoundary.SpeechSegment，刻意不互相 import。 */
export interface SpeechSegment {
  start: number;
  end: number;
}

export interface GroupTokenCuesOptions {
  /** 相邻 token 间隔超过该值（秒）即在此切分——对应自然停顿 / VAD 静音。 */
  maxGapSeconds?: number;
  /** 单条字幕最大时长（秒），超过则强制切分（防止长独白挤成一条）。 */
  maxDurationSeconds?: number;
  /** 单条字幕最大「显示宽度」（CJK 记 2，其余记 1），超过则强制切分。 */
  maxWidth?: number;
}

const DEFAULTS: Required<GroupTokenCuesOptions> = {
  maxGapSeconds: 0.5,
  maxDurationSeconds: 8,
  maxWidth: 40,
};

/** 句末标点：命中后在该 token 处收尾（标点保留在当前 cue 末尾）。 */
const SENTENCE_END = /[。！？!?…]["'”’）)]*$/;

/** 纯标点 token：不应因长度/时长上限被切到单独一条（如孤立的「。」）。 */
const PUNCT_ONLY = /^[\s。．.,，、!！?？…:：;；"'”’()（）【】《》\-—~～]+$/;

/** 把 `HH:MM:SS.mmm` / `MM:SS` / 纯秒（逗号或点皆可）解析为秒；非法返回 null。 */
function parseTime(time?: string): number | null {
  if (!time) return null;
  const normalized = time.trim().replace(',', '.');
  const parts = normalized.split(':').map((part) => Number(part));
  if (!parts.length || parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

/** 秒 → `HH:MM:SS,mmm`（SRT 逗号形式）。 */
function formatTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  const pad = (value: number, len = 2) => String(value).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** East-Asian-Width 近似：CJK / 全角记 2，其余记 1。用于单行字幕宽度上限。 */
function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe4f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6));
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 把 token 的 [start,end] 收敛到其内部「真实有声」子窗口（由语音边界 segments 判定）。
 *
 * 为什么需要：内置 whisper.cpp 开 VAD 时，token 级时间戳是「填满」的——段间静音被并进
 * 静音后第一个 token 的时长里（该 token 起点被前移到上一 token 末尾），于是 TS 侧看不到
 * token 间隔，groupTokenCues 切出来的时间轴是连续的、无停顿。这里用语音段把每个 token 贴回
 * 与其重叠最大的语音段内：静音后的 token 起点前移到真正的发声点、静音前的 token 末点回收到
 * 发声结束点——于是 token 间隔（gap）重新出现，groupTokenCues 即可按真实停顿切分。
 *
 * `segments` 为空（边界源不可用）时原样返回；token 落在静音（无重叠）时原样保留，避免错位。
 */
export function retimeTokensToSpeech(
  tokens: TokenTriple[],
  segments: SpeechSegment[],
): TokenTriple[] {
  if (tokens.length === 0 || !segments || segments.length === 0) return tokens;
  const sorted = [...segments]
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    )
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return tokens;

  return tokens.map((token) => {
    const start = parseTime(token?.[0]);
    const end = parseTime(token?.[1]);
    if (start === null || end === null || end <= start) return token;
    const win = bestOverlapWindow(sorted, start, end);
    if (!win) return token; // 与所有语音段无交集（多为空 token）→ 不动
    return [formatTime(win[0]), formatTime(win[1]), token?.[2] ?? ''];
  });
}

/** 返回 [s,e] 与「重叠最大的单个语音段」的交集 [start,end]；无重叠返回 null。 */
function bestOverlapWindow(
  segments: SpeechSegment[],
  s: number,
  e: number,
): [number, number] | null {
  let bestOverlap = 0;
  let best: [number, number] | null = null;
  for (const seg of segments) {
    if (seg.start >= e) break; // 已排序，后续段都在 token 之后
    if (seg.end <= s) continue;
    const lo = Math.max(s, seg.start);
    const hi = Math.min(e, seg.end);
    const overlap = hi - lo;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = [lo, hi];
    }
  }
  return best;
}

/**
 * 把「每 token 一段」的转写聚合成多条字幕。切分点（取并集）：
 * 1) token 间隔 > maxGapSeconds（自然停顿，主信号）；
 * 2) 当前 cue 命中句末标点（句子边界）；
 * 3) 累计时长 / 宽度超限（兜底，避免连续无停顿语流挤成一条）。
 *
 * 对非 token 级输入（每段已是整句）同样安全降级：仅按段间停顿/长度切分。
 */
export function groupTokenCues(
  tokens: TokenTriple[],
  options: GroupTokenCuesOptions = {},
): TokenTriple[] {
  const opts = { ...DEFAULTS, ...options };
  const cues: TokenTriple[] = [];

  let curStart = 0;
  let curEnd = 0;
  let curText = '';
  let hasCur = false;

  const flush = () => {
    if (!hasCur) return;
    const text = curText.trim();
    if (text) {
      cues.push([formatTime(curStart), formatTime(curEnd), text]);
    }
    hasCur = false;
    curText = '';
  };

  for (const token of tokens) {
    const start = parseTime(token?.[0]);
    const end = parseTime(token?.[1]);
    const text = token?.[2] ?? '';

    // 时间戳缺失的 token：并入当前 cue 文本（不作为切分依据），避免丢字。
    if (start === null || end === null) {
      if (hasCur) curText += text;
      continue;
    }

    if (hasCur) {
      const gap = start - curEnd;
      const nextDuration = Math.max(end, curEnd) - curStart;
      const nextWidth = visualWidth(curText) + visualWidth(text);
      // 纯标点 token 不触发长度/时长切分（避免孤立的「。」「，」单独成条），
      // 但真实停顿（gap）仍然切分。
      const punctOnly = PUNCT_ONLY.test(text.trim());
      if (
        gap > opts.maxGapSeconds ||
        (!punctOnly &&
          (nextDuration > opts.maxDurationSeconds || nextWidth > opts.maxWidth))
      ) {
        flush();
      }
    }

    if (!hasCur) {
      curStart = start;
      curEnd = end;
      curText = text;
      hasCur = true;
    } else {
      curText += text;
      curEnd = Math.max(curEnd, end);
    }

    // 句末标点：收尾当前 cue（标点已含在 curText 内）。
    if (SENTENCE_END.test(text.trim())) {
      flush();
    }
  }

  flush();
  return cues;
}

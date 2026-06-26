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
  /** 软切宽度：cue 显示宽度达到后，遇停顿性标点（，,；;）即软切（标点优先于硬上限）。 */
  softMaxWidth?: number;
  /** 软切时长（秒）：cue 时长达到后，遇停顿性标点即软切。 */
  softMaxDuration?: number;
}

const DEFAULTS: Required<GroupTokenCuesOptions> = {
  maxGapSeconds: 0.5,
  maxDurationSeconds: 8,
  maxWidth: 40,
  softMaxWidth: 10,
  softMaxDuration: 2.5,
};

/** 句末标点：命中后在该 token 处收尾（标点保留在当前 cue 末尾）。 */
const SENTENCE_END = /[。！？!?…]["'”’）)]*$/;

/**
 * 停顿性（非句末）标点：cue 达软长度后命中即「软切」（标点优先于硬宽度/时长上限，
 * 让长语流在自然停顿处断句而非切在词中）。
 * 刻意排除顿号「、」与冒号「：」——它们常用于号码 / 枚举内部（如「138、0013、800」），
 * 软切会把同一逻辑单元切碎。
 */
const SOFT_PUNCT = /[，,；;]["'”’）)]*$/;

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
 * 真实有声区间，于是 token 间隔（gap）重新出现，groupTokenCues 即可按真实停顿切分。
 *
 * 三类 token：
 *  1) 与某语音段有交集 → 收敛到交集首/末边界（anchored）；
 *  2) 落在静音的**空/空白/纯标点 token** → 原样保留（纯标点随相邻 cue 收尾，避免孤立标点条）；
 *  3) 落在静音的**内容 token** → 与相邻同类 token 组成「浮动 run」，**整段**贴到「就近段」
 *     （design D8/D11）：run 整体离后段更近（`gapNext ≤ gapPrev`）则前向贴到后段起点
 *     （whisper 前向填充的反向修正，如「請記錄…」「人工智能…」整句被填进静音）；离前段更近
 *     则后向贴到前段末点（句尾拖出 VAD 边界的尾字，如「…應用十分廣泛」的「廣泛」）。
 *     按 run 决策（而非逐 token）才能区分「前向填充整句」与「句尾拖尾单字」——二者单看一个
 *     token 完全同形（都紧贴前段末点），唯有看 run 整体离哪段近才不会把句尾尾字误抛到下一句。
 *     run 内零时长 token（whisper chunk 边界产物）一并纳入，按相对偏移平移并夹到段内。
 *
 * `segments` 为空（边界源不可用）时原样返回（优雅降级）。
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

  const info = tokens.map((t) => ({
    s: parseTime(t?.[0]),
    e: parseTime(t?.[1]),
    text: t?.[2] ?? '',
  }));
  const out: TokenTriple[] = tokens.map((t) => t);

  const pointInSeg = (t: number): boolean =>
    sorted.some((seg) => seg.start <= t && t <= seg.end);

  // anchored：有时长 token 与某语音段有交集，或零时长 token 的时间点落在某段内。
  // 零时长内容 token（whisper chunk 边界产物）必须按「点是否在段内」判定——否则会被误判为
  // 浮动而被抛到别处（如句中零时长 token 被抛到下一句）。
  const isAnchored = (k: number): boolean => {
    const { s, e } = info[k];
    if (s === null || e === null) return false;
    if (e > s) return bestOverlapWindow(sorted, s, e) !== null;
    return pointInSeg(s);
  };

  // 浮动内容 token：时间有效、未 anchored、且非空 / 非纯标点（含零时长内容）。
  const isFloatingContent = (k: number): boolean => {
    const { s, e, text } = info[k];
    if (s === null || e === null) return false;
    if (isAnchored(k)) return false;
    const trimmed = text.trim();
    return !!trimmed && !PUNCT_ONLY.test(trimmed);
  };

  let i = 0;
  while (i < tokens.length) {
    const { s, e, text } = info[i];
    if (s === null || e === null) {
      out[i] = tokens[i];
      i += 1;
      continue;
    }
    if (isAnchored(i)) {
      // 有时长 → 收敛到与语音段的交集；零时长（点在段内）→ 原样保留其时间点。
      const win = e > s ? bestOverlapWindow(sorted, s, e) : null;
      out[i] = win ? [formatTime(win[0]), formatTime(win[1]), text] : tokens[i];
      i += 1;
      continue;
    }
    if (!isFloatingContent(i)) {
      out[i] = tokens[i]; // 静音里的空 / 标点 token：原样保留
      i += 1;
      continue;
    }

    // 浮动内容 run [i, j)：连续浮动内容 token。
    let j = i;
    while (j < tokens.length && isFloatingContent(j)) j += 1;
    const runStart = info[i].s as number;
    const lastS = info[j - 1].s as number;
    const lastE = info[j - 1].e as number;
    const runEnd = lastE > lastS ? lastE : lastS;

    let prevSeg: SpeechSegment | null = null;
    for (const seg of sorted) if (seg.end <= runStart) prevSeg = seg;
    const nextSeg = sorted.find((seg) => seg.start >= runEnd) ?? null;
    const gapPrev = prevSeg ? runStart - prevSeg.end : Infinity;
    const gapNext = nextSeg ? nextSeg.start - runEnd : Infinity;

    if (gapNext <= gapPrev && nextSeg) {
      // 前向（离后段更近）：whisper 把整段静音填进了「静音后首个 token」→ 整 run 平移到
      // 后段起点，保留 run 内相对偏移，夹到段内。零时长 token 落在后段起点，随后段首 token 合并。
      const delta = nextSeg.start - runStart;
      for (let k = i; k < j; k += 1) {
        let lo = (info[k].s as number) + delta;
        let hi = (info[k].e as number) + delta;
        lo = Math.min(Math.max(lo, nextSeg.start), nextSeg.end);
        hi = Math.min(Math.max(hi, lo), nextSeg.end);
        out[k] = [formatTime(lo), formatTime(hi), info[k].text];
      }
    } else if (prevSeg) {
      // 后向（离前段更近）：句尾尾字被 whisper 放到了 VAD 末点之外 → 整 run 平移到前段末点
      // 紧接上一句，保留 run 内相对偏移与时长。delta ≤ 0；由 prevSeg.end ≤ runStart 且
      // runEnd ≤ nextSeg.start 可证平移后仍落在 (prevSeg.end, nextSeg.start] 内，
      // 不会与前后 anchored token 反序或越界，故无需再夹取。
      const delta = prevSeg.end - runStart;
      for (let k = i; k < j; k += 1) {
        const lo = (info[k].s as number) + delta;
        const hi = Math.max((info[k].e as number) + delta, lo);
        out[k] = [formatTime(lo), formatTime(hi), info[k].text];
      }
    } else {
      for (let k = i; k < j; k += 1) out[k] = tokens[k]; // 无前后段：原样
    }
    i = j;
  }
  return out;
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
 * 3) cue 达软长度（softMaxWidth / softMaxDuration）后命中停顿性标点（，,；;）→ 标点优先软切（§6.2）；
 * 4) 累计时长 / 宽度超硬上限（maxDuration / maxWidth）兜底，避免连续无停顿语流挤成一条。
 *
 * 另：开新 cue 时若首 token 为纯标点，则贴回上一条 cue 末尾（前导标点归属 §6.2，
 * 避免出现以「，」开头的字幕条；不改上一条时间，仅补字符）。
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
      // 前导标点归属（§6.2）：纯标点不另起 cue，贴回上一条末尾，避免「，xxx」这类
      // 以标点开头的字幕条（标点在静音里时间不可信，故只补字符、不动上一条时间）。
      if (PUNCT_ONLY.test(text.trim()) && cues.length > 0) {
        const prev = cues[cues.length - 1];
        prev[2] += text.trim();
        continue;
      }
      curStart = start;
      curEnd = end;
      curText = text;
      hasCur = true;
    } else {
      curText += text;
      curEnd = Math.max(curEnd, end);
    }

    // 收尾当前 cue（标点已含在 curText 内）：
    //  - 句末标点：立即切（句子边界）；
    //  - 停顿性标点：cue 达软宽度/软时长后软切（§6.2，标点优先于硬上限，避免切在词中）。
    const trimmed = text.trim();
    if (
      SENTENCE_END.test(trimmed) ||
      (SOFT_PUNCT.test(trimmed) &&
        (visualWidth(curText) >= opts.softMaxWidth ||
          curEnd - curStart >= opts.softMaxDuration))
    ) {
      flush();
    }
  }

  flush();
  return cues;
}

/**
 * 把每条 cue 的起止收敛到它「真正重叠的语音段」范围内（design D8-B）：
 * 起点上推到首个重叠段的 start、末点下收到末个重叠段的 end；
 * 完全不与任何语音段重叠的 cue 原样返回（不臆断）。
 *
 * 作用：兜住「cue 起止渗进静音」（内容 token 被 whisper 前向填充进前段静音、或末 token
 * 过冲到 VAD chunk 边界）导致的跨停顿，使停顿（gap）在 cue 之间复现——与填充方向无关，
 * 作为 retime 前向贴齐（D8-A）的后处理兜底。`segments` 为空时原样返回（优雅降级）。
 */
export function clampCuesToSegments(
  cues: TokenTriple[],
  segments: SpeechSegment[],
): TokenTriple[] {
  if (cues.length === 0 || !segments || segments.length === 0) return cues;
  const sorted = [...segments]
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    )
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return cues;

  return cues.map((cue) => {
    const s = parseTime(cue?.[0]);
    const e = parseTime(cue?.[1]);
    if (s === null || e === null || e <= s) return cue;
    let lo: number | null = null;
    let hi: number | null = null;
    for (const seg of sorted) {
      if (seg.start >= e) break; // 已排序，后续段都在 cue 之后
      if (seg.end <= s) continue; // 在 cue 之前
      if (lo === null) lo = Math.max(s, seg.start);
      hi = Math.min(e, seg.end);
    }
    if (lo === null || hi === null || hi <= lo) return cue;
    return [formatTime(lo), formatTime(hi), cue?.[2] ?? ''];
  });
}

export interface ClampDominantOptions {
  /** 仅把 cue 收敛到「被它覆盖 ≥ 该比例」的语音段（默认 0.5）。避免只擦到前句段尾的弱重叠把 cue 误夹成碎片。 */
  minSegmentCoverage?: number;
  /** 收敛后时长下限（秒）；低于则放弃收敛、保留原 cue（默认 0.3）。 */
  minDurationSeconds?: number;
}

const CLAMP_DOMINANT_DEFAULTS: Required<ClampDominantOptions> = {
  minSegmentCoverage: 0.5,
  minDurationSeconds: 0.3,
};

/**
 * 安全版「停顿还原」（design D13，用于 VAD-off）：只把 cue 的起止收敛到它「实质覆盖」
 * （overlap / segLen ≥ `minSegmentCoverage`）的语音段；只擦到段尾 / 段头的弱重叠段一律忽略。
 *
 * 与 `clampCuesToSegments`（D8-B）的区别：后者锚到「首个 / 末个**任意**重叠段」，对 VAD-off 下
 * 与外部段漂移的 cue 会被前句段尾的弱重叠误夹成 0.x 秒碎片（实测 `请记录以下信息` 被夹成 0.3s）。
 * 本函数按「段覆盖率」筛掉弱重叠：cue 真正「装下」某语音段时才用它当边界。
 *
 * 安全性：收敛只会让 cue 变窄（起点后移 / 终点前移），故只会**制造 / 扩大**相邻 cue 间的停顿 gap，
 * 绝不把文本搬到别处、绝不与前后 cue 反序 / 重叠（区别于 retime 的整体平移）。无实质覆盖段、
 * 或收敛后过短 → 原样返回（交给 `dropCuesInDeepSilence` 判幻觉）。`segments` 为空 → 原样（优雅降级）。
 */
export function clampCuesToDominantSegments(
  cues: TokenTriple[],
  segments: SpeechSegment[],
  options: ClampDominantOptions = {},
): TokenTriple[] {
  const opts = { ...CLAMP_DOMINANT_DEFAULTS, ...options };
  if (cues.length === 0 || !segments || segments.length === 0) return cues;
  const sorted = [...segments]
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    )
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return cues;

  return cues.map((cue) => {
    const s = parseTime(cue?.[0]);
    const e = parseTime(cue?.[1]);
    if (s === null || e === null || e <= s) return cue;
    let lo: number | null = null;
    let hi: number | null = null;
    for (const seg of sorted) {
      if (seg.start >= e) break; // 已排序，后续段都在 cue 之后
      if (seg.end <= s) continue; // 在 cue 之前
      const overlap = Math.min(e, seg.end) - Math.max(s, seg.start);
      const segLen = seg.end - seg.start;
      if (segLen <= 0 || overlap / segLen < opts.minSegmentCoverage) continue; // 弱重叠（只擦到段头/尾）→ 跳过
      if (lo === null) lo = Math.max(s, seg.start);
      hi = Math.min(e, seg.end);
    }
    if (lo === null || hi === null || hi <= lo) return cue; // 无实质覆盖段 → 原样
    if (hi - lo < opts.minDurationSeconds) return cue; // 收敛后过短 → 放弃，保留可读原 cue
    return [formatTime(lo), formatTime(hi), cue?.[2] ?? ''];
  });
}

export interface MergeShortCuesOptions {
  /** 「实义字符数」≤ 该值的 cue 视为过短碎片，尝试并入上一条（默认 1 = 仅单字 / 单字+标点）。 */
  minContentChars?: number;
  /** 仅当与上一条间隔 ≤ 该值（秒）才并入——只桥接「词内假停顿」，不跨越真实停顿（默认 1.2s）。 */
  maxJoinGapSeconds?: number;
  /** 并入后显示宽度上限，超过则保留碎片不并（避免产生超长 cue，默认 40）。 */
  maxWidth?: number;
}

const MERGE_DEFAULTS: Required<MergeShortCuesOptions> = {
  minContentChars: 1,
  maxJoinGapSeconds: 1.2,
  maxWidth: 40,
};

/**
 * 「实义字符」数：仅计字母 / 数字 / 表意文字（CJK / 假名 / 谚文），排除标点 / 空白 / 符号。
 * 按 codepoint 区间判定（不用 \p{…}/u 标志，兼容较低 TS target）。
 */
function contentCharCount(text: string): number {
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isAsciiAlnum =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    const isCjk =
      (code >= 0x3400 && code <= 0x9fff) || // CJK 统一表意（含扩展 A）
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
      (code >= 0x3040 && code <= 0x30ff) || // 平假名 + 片假名
      (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
      (code >= 0xff10 && code <= 0xff19) || // 全角数字
      (code >= 0xff21 && code <= 0xff3a) || // 全角大写
      (code >= 0xff41 && code <= 0xff5a); // 全角小写
    if (isAsciiAlnum || isCjk) n += 1;
  }
  return n;
}

/**
 * 合并「过短碎片 cue」（§6.2 健壮性）：把实义字符数 ≤ `minContentChars` 的 cue 并入上一条。
 *
 * 动机：弱模型（如 base）+ VAD 在词中误插的亚秒级假停顿，会让 retime/group 把单个字
 * 切成独立字幕条（如「廣」「泛」各一条）。本后处理把这类碎片并回相邻 cue：
 *  - 用「实义字符数」而非显示宽度判定（CJK 句号宽度也是 2，按宽度会漏判「泛。」这类字+标点）；
 *  - 仅当与上一条间隔 ≤ `maxJoinGapSeconds` 才并（桥接词内假停顿，**不跨真实停顿**：
 *    真实停顿多为数秒，远大于阈值）；
 *  - 并入后显示宽度超过 `maxWidth` 则不并（避免把碎片硬塞成超长 cue）；
 *  - 连续多个碎片会级联并入同一条（首个碎片若其前是真实停顿则原样保留）。
 *
 * 时间：上一条末点延伸到碎片末点（碎片确实发声在那附近，单字误差可忽略）；输出时间统一规范化。
 */
export function mergeShortCues(
  cues: TokenTriple[],
  options: MergeShortCuesOptions = {},
): TokenTriple[] {
  const opts = { ...MERGE_DEFAULTS, ...options };
  if (cues.length === 0) return cues;
  const out: TokenTriple[] = [];
  for (const cue of cues) {
    const s = parseTime(cue?.[0]);
    const e = parseTime(cue?.[1]);
    const text = cue?.[2] ?? '';
    const startStr = s !== null ? formatTime(s) : (cue?.[0] ?? '');
    const endStr = e !== null ? formatTime(e) : (cue?.[1] ?? '');
    const isFragment =
      text.trim() !== '' && contentCharCount(text) <= opts.minContentChars;
    if (out.length > 0 && isFragment && s !== null) {
      const prev = out[out.length - 1];
      const pe = parseTime(prev[1]);
      const pw = visualWidth((prev[2] ?? '').trim());
      const gap = pe !== null ? s - pe : Infinity;
      if (
        gap <= opts.maxJoinGapSeconds &&
        pw + visualWidth(text.trim()) <= opts.maxWidth
      ) {
        prev[2] = (prev[2] ?? '') + text;
        if (e !== null && (pe === null || e > pe)) prev[1] = endStr;
        continue;
      }
    }
    out.push([startStr, endStr, text]);
  }
  return out;
}

export interface DropDeepSilenceOptions {
  /**
   * cue 与最近语音段的距离超过该值（秒）且与所有段零重叠 → 判为「深静音」并丢弃（默认 1.5s）。
   * 阈值刻意保守：紧贴语音段边界（VAD 漏检的真实尾字 / 起字，如句尾「廣泛」）距离≈0 会被保留，
   * 只有远离任何语音的悬空 cue（典型为 VAD-off 时 whisper 在长静音里的幻觉）才被丢。
   */
  minSilenceDistanceSeconds?: number;
}

const DROP_DEFAULTS: Required<DropDeepSilenceOptions> = {
  minSilenceDistanceSeconds: 1.5,
};

/**
 * 丢弃「落在深静音里的悬空 cue」（VAD-off 路径专用护栏）。
 *
 * 关闭 whisper 内部 VAD 时 token 时间最贴近真实语流（粒度更细），但 whisper 可能在长静音里
 * 产出幻觉文本。本后处理只在「cue 与所有语音段零重叠 **且** 离最近语音段 >
 * `minSilenceDistanceSeconds`」时丢弃——既清掉深静音幻觉，又**不误删**贴着 VAD 边界的真实语音
 * （VAD 常把句尾尾字 / 句首起字切在段外，它们距段 < 阈值，应保留）。
 *
 * `segments` 为空（边界源不可用）时原样返回（优雅降级，绝不在无依据时删字幕）。与 retime / clamp
 * 不同，本函数**不修改**任何 cue 的时间或文本，只做整条保留 / 丢弃。
 */
export function dropCuesInDeepSilence(
  cues: TokenTriple[],
  segments: SpeechSegment[],
  options: DropDeepSilenceOptions = {},
): TokenTriple[] {
  if (cues.length === 0 || !segments || segments.length === 0) return cues;
  const opts = { ...DROP_DEFAULTS, ...options };
  const sorted = [...segments]
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    )
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return cues;

  return cues.filter((cue) => {
    const s = parseTime(cue?.[0]);
    const e = parseTime(cue?.[1]);
    if (s === null || e === null || e <= s) return true; // 不可解析 → 保留
    let dist = Infinity;
    for (const seg of sorted) {
      if (Math.min(e, seg.end) - Math.max(s, seg.start) > 0) return true; // 有重叠 → 保留
      if (seg.end <= s) dist = Math.min(dist, s - seg.end);
      else if (seg.start >= e) dist = Math.min(dist, seg.start - e);
    }
    return dist <= opts.minSilenceDistanceSeconds; // 近边界保留；深静音丢弃
  });
}

export interface MinDisplayDurationOptions {
  /** 每条字幕的最短显示时长（秒）硬下限（默认 0.8）。 */
  minDurationSeconds?: number;
  /** 按「实义字符数 × 该值」估算可读时长，与下限取大（默认 0.06 s/字）。设 0 关闭按长度缩放，只用硬下限。 */
  perCharSeconds?: number;
  /** 可读时长上限（秒）——再长的文本也不强制延长超过此值（默认 2.5）。 */
  maxDurationSeconds?: number;
  /** 延长末点时与「下一条起点」保留的保护间隔（秒），保证停顿仍可见、绝不与下一条重叠（默认 0.1）。 */
  guardGapSeconds?: number;
}

const MIN_DISPLAY_DEFAULTS: Required<MinDisplayDurationOptions> = {
  minDurationSeconds: 0.8,
  perCharSeconds: 0.06,
  maxDurationSeconds: 2.5,
  guardGapSeconds: 0.1,
};

/**
 * 保证每条字幕的「最短可读显示时长」（design D15，VAD-on / VAD-off 共用的收尾护栏）。
 *
 * 动机：`maxWidth` 硬切分点可能正好落在 whisper 把句首词压缩到语音段边界前的位置，切出「文本
 * 正常、时长却 < 0.5s」的 cue（实测 EN `Artificial intelligence technology is` 0.28s、JA 19 字 0.53s）。
 * 这类 cue `mergeShortCues` 不收（非单字碎片）、`clampCuesToDominantSegments` 不收（无段实质覆盖）、
 * `dropCuesInDeepSilence` 不删（贴边界真实词），于是漏到成片，太快看不清。
 *
 * 本函数只把过短 cue 的**末点**往后延伸到「期望可读时长」，并封顶在「下一条起点 − guardGap」，
 * 即只吃掉本条后面的空隙、绝不与下一条重叠、绝不缩短任何 cue、绝不改起点 / 文本。期望时长 =
 * clamp(实义字符数 × perCharSeconds, minDurationSeconds, maxDurationSeconds)。
 *
 * 安全边界：末条（其后再无可解析起点）不延长——纯函数无音频总长，延长末条可能越过音频结尾，
 * 交由 `trimSubtitleTrailingSilence` 处理。下一条过近导致无可用空隙时原样返回（只能部分改善）。
 */
export function enforceMinDisplayDuration(
  cues: TokenTriple[],
  options: MinDisplayDurationOptions = {},
): TokenTriple[] {
  const opts = { ...MIN_DISPLAY_DEFAULTS, ...options };
  if (cues.length === 0) return cues;

  const parsed = cues.map((cue) => ({
    s: parseTime(cue?.[0]),
    e: parseTime(cue?.[1]),
    text: cue?.[2] ?? '',
    raw: cue,
  }));

  return parsed.map((cur, idx): TokenTriple => {
    const { s, e, text, raw } = cur;
    if (s === null || e === null || e <= s) return raw; // 不可解析 / 非法 → 原样
    const normalized: TokenTriple = [formatTime(s), formatTime(e), text];
    const desired = Math.min(
      opts.maxDurationSeconds,
      Math.max(
        opts.minDurationSeconds,
        contentCharCount(text) * opts.perCharSeconds,
      ),
    );
    if (e - s >= desired) return normalized; // 已足够长

    // 下一条「可解析起点」= 延长上限；无（末条或后续都不可解析）→ 保守不延长。
    let nextStart: number | null = null;
    for (let k = idx + 1; k < parsed.length; k += 1) {
      if (parsed[k].s !== null) {
        nextStart = parsed[k].s;
        break;
      }
    }
    if (nextStart === null) return normalized;

    const newEnd = Math.min(s + desired, nextStart - opts.guardGapSeconds);
    if (newEnd <= e) return normalized; // 下一条太近，无空隙可延 → 原样
    return [formatTime(s), formatTime(newEnd), text];
  });
}

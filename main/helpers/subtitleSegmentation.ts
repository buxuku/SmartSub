/**
 * 内置 whisper.cpp 引擎的「token → 字幕」聚合（原生 segment-aware 时间轴版）。
 *
 * 上游 fork（buxuku/whisper.cpp）已在原生层提供：
 *   - `token_timestamps:true, max_len:0` → 逐 token 输出 `{ text, t0, t1, p }`（t0/t1 为毫秒）；
 *   - token 时间已做 **segment-aware 映射**：落在语音段内的 token 线性映射回原始时间轴，落在
 *     段间「人工静音」的 token 就近吸附到真实语音边界——于是**段间停顿天然以 token gap 体现**，
 *     不再需要 TS 侧用外部 VAD 把 token 贴回有声区间（旧 `retimeTokensToSpeech` 已删除）。
 *
 * 因此本模块只剩「成句」职责（与边界/停顿还原无关）：
 *   tokensToTriples（毫秒 → [startStr,endStr,text]）
 *     → groupTokenCues（按 token gap / 句末标点 / 软切标点 / 长度上限成句；
 *       硬上限切分回溯到最近可断标点，避免孤立句尾词）
 *     → mergeShortCues（单字碎片并回相邻 cue）
 *     → enforceMinDisplayDuration（最短可读显示时长护栏）。
 *
 * 纯函数（不依赖 electron / fs / 原生库），便于 test:engines 单测；故内联时间解析/格式化。
 */

/** 字幕/ token 三元组：[startStr, endStr, text]，时间形如 `HH:MM:SS.mmm` 或 SRT 逗号形式。 */
export type TokenTriple = [string, string, string];

/** 原生 addon 的逐 token 输出（t0/t1 为毫秒，原始时间轴、已 segment-aware 映射）。 */
export interface NativeToken {
  text: string;
  t0: number;
  t1: number;
  p?: number;
}

export interface GroupTokenCuesOptions {
  /** 相邻 token 间隔超过该值（秒）即在此切分——对应自然停顿 / VAD 段间静音。 */
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

/**
 * 硬切回溯可断标点：句内停顿/枚举标点（含顿号、冒号）。
 * 与 SOFT_PUNCT 的区别：软切是「主动提前断句」，顿号/冒号参与会切碎枚举与号码；
 * 硬切回溯则发生在「必须切一刀」时——切在任何标点后都优于把句尾词孤立成条
 * （如「…应用十分|广泛。」），故这里放宽收录。
 */
const HARD_BREAK_PUNCT = /[，,；;、：:]["'”’）)]*$/;

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
 * 原生逐 token 输出（毫秒）→ TokenTriple（字符串时间轴），喂给 groupTokenCues。
 * 时间非法（缺失 / NaN）的一端输出空串：groupTokenCues 会把该 token 文本并入当前 cue
 * 而不作为切分依据（不丢字、不误切）。
 */
export function tokensToTriples(tokens: NativeToken[]): TokenTriple[] {
  if (!Array.isArray(tokens)) return [];
  return tokens.map((tok): TokenTriple => {
    const t0 = Number(tok?.t0);
    const t1 = Number(tok?.t1);
    const startStr = Number.isFinite(t0) ? formatTime(t0 / 1000) : '';
    const endStr = Number.isFinite(t1) ? formatTime(t1 / 1000) : '';
    return [startStr, endStr, tok?.text ?? ''];
  });
}

/** whisper 内部 VAD 暴露的语音段（秒，原始时间轴）。 */
export interface SpeechSegment {
  start: number;
  end: number;
}

/** 原生 addon 暴露的 VAD 段（毫秒）→ SpeechSegment（秒），并按起点排序、丢弃非法段。 */
export function vadSegmentsToSpeech(
  vad: Array<{ t0: number; t1: number }> | undefined,
): SpeechSegment[] {
  if (!Array.isArray(vad)) return [];
  return vad
    .map((v) => ({ start: Number(v?.t0) / 1000, end: Number(v?.t1) / 1000 }))
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    )
    .sort((a, b) => a.start - b.start);
}

/** token 中点所属语音段索引：优先包含该中点的段，否则取距离最近的段。 */
function segIndexForMid(mid: number, segs: SpeechSegment[]): number {
  for (let i = 0; i < segs.length; i++) {
    if (mid >= segs[i].start && mid <= segs[i].end) return i;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < segs.length; i++) {
    const d = mid < segs[i].start ? segs[i].start - mid : mid - segs[i].end;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * 用 whisper **内部 VAD 段**（addon 已免费暴露，非外部二次 VAD）把逐 token 时间「吸附」回真实语音：
 * 每个 token 按中点归属到最近的语音段，并把它的 [start,end] 夹在该段 [start,end] 内。
 *
 * 解决的问题：whisper 的 token 级时间戳是「按 voice_length 把整段时长摊给 token」的启发式，
 * 当某个转写 segment 跨越了一段人工静音（VAD 删除的静音）时，medium 这类模型会把 token 时间
 * **连续地摊过静音**（实测 medium 在 21.5→25.1s 静音处最大 token 间隔仅 600ms，字幕直接糊穿静音；
 * 而 tiny 恰好摊出 3.67s 间隔才躲过）。夹紧后：静音前 token≤段尾、静音后 token≥段首，groupTokenCues
 * 依据由此产生的真实间隔自然断句，字幕不再压在静音上——且与模型无关（medium/tiny 一致）。
 */
export function clampTriplesToSpeechSegments(
  triples: TokenTriple[],
  segments: SpeechSegment[],
): TokenTriple[] {
  if (!Array.isArray(triples) || !segments?.length) return triples;
  const segs = [...segments].sort((a, b) => a.start - b.start);
  return triples.map((triple): TokenTriple => {
    const st = parseTime(triple?.[0]);
    const en = parseTime(triple?.[1]);
    const text = triple?.[2] ?? '';
    if (st === null || en === null)
      return [triple?.[0] ?? '', triple?.[1] ?? '', text];
    const mid = (st + en) / 2;
    const seg = segs[segIndexForMid(mid, segs)];
    const cs = Math.min(Math.max(st, seg.start), seg.end);
    const ce = Math.max(cs, Math.min(Math.max(en, seg.start), seg.end));
    return [formatTime(cs), formatTime(ce), text];
  });
}

export interface ClampDominantOptions {
  /** 仅把 cue 收敛到「被它覆盖 ≥ 该比例」的语音段（默认 0.5），避免弱重叠把 cue 夹成碎片。 */
  minSegmentCoverage?: number;
  /** 收敛后时长下限（秒）；低于则放弃收敛、保留原 cue（默认 0.3）。 */
  minDurationSeconds?: number;
}

const CLAMP_DOMINANT_DEFAULTS: Required<ClampDominantOptions> = {
  minSegmentCoverage: 0.5,
  minDurationSeconds: 0.3,
};

/**
 * cue 级「主导段」收敛——**VAD 关（文字最准档）专用**。
 *
 * 关 VAD 时 token 时间是**全程线性**（无段间停顿可断），逐 token clamp 会把跨静音的词切碎、
 * 产出 0 时长碎片。改在**成句后**按「cue 实质覆盖（overlap/segLen ≥ minSegmentCoverage）」
 * 的语音段收敛 cue 起止：整条 cue 后移到静音之后 / 终点前移到静音之前——**不碎词**、只制造或
 * 扩大相邻停顿 gap，绝不把文本搬到别处、不与前后 cue 反序。无实质覆盖段 / 收敛后过短 → 原样。
 * `segments` 为空 → 原样（优雅降级）。
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
      if (seg.start >= e) break;
      if (seg.end <= s) continue;
      const overlap = Math.min(e, seg.end) - Math.max(s, seg.start);
      const segLen = seg.end - seg.start;
      if (segLen <= 0 || overlap / segLen < opts.minSegmentCoverage) continue;
      if (lo === null) lo = Math.max(s, seg.start);
      hi = Math.min(e, seg.end);
    }
    if (lo === null || hi === null || hi <= lo) return cue;
    if (hi - lo < opts.minDurationSeconds) return cue;
    return [formatTime(lo), formatTime(hi), cue?.[2] ?? ''];
  });
}

export interface DropDeepSilenceOptions {
  /** cue 与所有语音段零重叠且离最近段 > 该值（秒）→ 判深静音幻觉并丢弃（默认 1.5s）。 */
  minSilenceDistanceSeconds?: number;
}

const DROP_DEFAULTS: Required<DropDeepSilenceOptions> = {
  minSilenceDistanceSeconds: 1.5,
};

/**
 * 丢弃「落在深静音里的悬空 cue」——**VAD 关专用护栏**。关 VAD 时 token 最贴真实语流但 whisper
 * 可能在长静音里产幻觉文本；仅当 cue 与所有语音段零重叠**且**离最近段 > 阈值才丢（贴边界的
 * 真实尾字/起字距段≈0 会保留）。不改任何时间/文本，只整条保留或丢弃。`segments` 空 → 原样。
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
    if (s === null || e === null || e <= s) return true;
    let dist = Infinity;
    for (const seg of sorted) {
      if (Math.min(e, seg.end) - Math.max(s, seg.start) > 0) return true;
      if (seg.end <= s) dist = Math.min(dist, s - seg.end);
      else if (seg.start >= e) dist = Math.min(dist, seg.start - e);
    }
    return dist <= opts.minSilenceDistanceSeconds;
  });
}

/**
 * 把「每 token 一段」的转写聚合成多条字幕。切分点（取并集）：
 * 1) token 间隔 > maxGapSeconds（自然停顿，主信号——原生 segment-aware 映射已让段间停顿以此体现）；
 * 2) 当前 cue 命中句末标点（句子边界）；
 * 3) cue 达软长度（softMaxWidth / softMaxDuration）后命中停顿性标点（，,；;）→ 标点优先软切（§6.2）；
 * 4) 累计时长 / 宽度超硬上限（maxDuration / maxWidth）兜底，避免连续无停顿语流挤成一条。
 *    硬切**优先回溯**到 cue 内最后一个可断标点（，,；;、：:）后分割，余部（真实词级时间）
 *    作新 cue 开头，避免把句尾词孤切成条（如「…应用十分|广泛。」）；若余部并入本 token 后
 *    仍超限则余部单独成条（保证任何 cue 不超宽）；句内无可断标点时行为与回溯前一致。
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

  // 当前 cue 的 token 缓冲：保留逐 token 时间，供硬切回溯在标点处重新分割。
  interface BufTok {
    start: number;
    end: number;
    text: string;
  }
  let buf: BufTok[] = [];
  let curStart = 0;
  let curEnd = 0;
  let curText = '';
  let hasCur = false;

  const setCur = (toks: BufTok[]) => {
    buf = toks;
    hasCur = toks.length > 0;
    if (!hasCur) {
      curText = '';
      return;
    }
    curStart = toks[0].start;
    curEnd = toks.reduce((m, t) => Math.max(m, t.end), toks[0].end);
    curText = toks.map((t) => t.text).join('');
  };

  const flush = () => {
    if (!hasCur) return;
    const text = curText.trim();
    if (text) {
      cues.push([formatTime(curStart), formatTime(curEnd), text]);
    }
    setCur([]);
  };

  for (const token of tokens) {
    const start = parseTime(token?.[0]);
    const end = parseTime(token?.[1]);
    const text = token?.[2] ?? '';

    // 时间戳缺失的 token：并入当前 cue 文本（不作为切分依据），避免丢字。
    if (start === null || end === null) {
      if (hasCur) {
        curText += text;
        if (buf.length) buf[buf.length - 1].text += text;
      }
      continue;
    }

    if (hasCur) {
      const gap = start - curEnd;
      const nextDuration = Math.max(end, curEnd) - curStart;
      const nextWidth = visualWidth(curText) + visualWidth(text);
      // 纯标点 token 不触发长度/时长切分（避免孤立的「。」「，」单独成条），
      // 但真实停顿（gap）仍然切分。
      const punctOnly = PUNCT_ONLY.test(text.trim());
      if (gap > opts.maxGapSeconds) {
        flush();
      } else if (
        !punctOnly &&
        (nextDuration > opts.maxDurationSeconds || nextWidth > opts.maxWidth)
      ) {
        // 硬上限触发：回溯到 cue 内最后一个可断标点后切分（避免孤立句尾词）。
        // 余部（标点后的 token）留作新 cue 开头；若余部加上本 token 仍超限，
        // 则余部也单独成条（保证任何 cue 不超宽；单字余部由 mergeShortCues 回收）。
        let cut = -1;
        for (let i = buf.length - 2; i >= 0; i -= 1) {
          if (HARD_BREAK_PUNCT.test(buf[i].text.trim())) {
            cut = i;
            break;
          }
        }
        if (cut >= 0) {
          const rest = buf.slice(cut + 1);
          setCur(buf.slice(0, cut + 1));
          flush();
          setCur(rest);
          const restWidth = visualWidth(curText) + visualWidth(text);
          const restDuration = Math.max(end, curEnd) - curStart;
          if (
            restWidth > opts.maxWidth ||
            restDuration > opts.maxDurationSeconds
          ) {
            flush();
          }
        } else {
          flush();
        }
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
      setCur([{ start, end, text }]);
    } else {
      buf.push({ start, end, text });
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
 * 合并「过短碎片 cue」（§6.2 健壮性）：把实义字符数 ≤ `minContentChars` 的 cue 并入上一条。
 *
 * 动机：弱模型（如 base）在词中误切的亚秒级碎片，会让 group 把单个字切成独立字幕条
 * （如「廣」「泛」各一条）。本后处理把这类碎片并回相邻 cue：
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
 * 保证每条字幕的「最短可读显示时长」（design D15，收尾护栏）。
 *
 * 动机：`maxWidth` 硬切分点可能正好落在 whisper 把句首词压缩到语音段边界前的位置，切出「文本
 * 正常、时长却 < 0.5s」的 cue。这类 cue `mergeShortCues` 不收（非单字碎片），于是漏到成片、太快看不清。
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

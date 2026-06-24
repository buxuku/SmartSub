/**
 * 字幕格式编解码模块（零依赖，纯函数，便于单元测试）。
 *
 * 统一支持常见字幕格式的解析（导入）与序列化（导出）：
 *   - srt：SubRip，应用内部规范格式
 *   - vtt：WebVTT
 *   - ass/ssa：Advanced SubStation Alpha
 *   - lrc：歌词格式（仅有起始时间）
 *   - txt：纯文本（无时间轴，仅用于导出）
 *
 * 设计要点：
 *   - 内部统一用毫秒（ms）表示时间，避免各格式时间精度差异导致的累积误差。
 *   - 解析结果对齐应用既有的 Subtitle 模型 { id, startEndTime, content[] }，
 *     其中 startEndTime 始终是 SRT 风格字符串，保证下游（播放器/校对/合并）无需改动取值方式。
 *   - 同时提供「整文件序列化」与「逐条追加序列化」两套接口，
 *     以兼容翻译流程边翻译边写入（流式追加）的既有实现。
 */

export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'lrc' | 'txt';

export interface SubtitleCue {
  startMs: number;
  endMs: number;
  text: string; // 多行以 \n 连接
}

// 与应用既有 Subtitle 模型结构兼容（main/translate/types、renderer/hooks/useSubtitles）
export interface SubtitleEntry {
  id: string;
  startEndTime: string;
  content: string[];
}

export const SUPPORTED_SUBTITLE_FORMATS: SubtitleFormat[] = [
  'srt',
  'vtt',
  'ass',
  'lrc',
  'txt',
];

// 可作为「导入」来源的格式（txt 无时间轴，不支持导入）
export const IMPORTABLE_SUBTITLE_FORMATS: SubtitleFormat[] = [
  'srt',
  'vtt',
  'ass',
  'lrc',
];

const EXT_TO_FORMAT: Record<string, SubtitleFormat> = {
  '.srt': 'srt',
  '.vtt': 'vtt',
  '.ass': 'ass',
  '.ssa': 'ass',
  '.lrc': 'lrc',
  '.txt': 'txt',
};

const FORMAT_TO_EXT: Record<SubtitleFormat, string> = {
  srt: '.srt',
  vtt: '.vtt',
  ass: '.ass',
  lrc: '.lrc',
  txt: '.txt',
};

const TIMESTAMP_PATTERN = String.raw`(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[,.]\d{1,6})?`;
const TIMING_LINE_PATTERN = new RegExp(
  `${TIMESTAMP_PATTERN}\\s*-->\\s*${TIMESTAMP_PATTERN}`,
);

/** 根据文件路径/扩展名推断字幕格式，未知时返回 null。 */
export function detectSubtitleFormatByExtension(
  filePath: string,
): SubtitleFormat | null {
  const match = /\.[^.\\/]+$/.exec(filePath || '');
  const ext = match ? match[0].toLowerCase() : '';
  return EXT_TO_FORMAT[ext] || null;
}

/** 根据文件路径/扩展名推断字幕格式，未知时回退为 srt。 */
export function detectSubtitleFormat(filePath: string): SubtitleFormat {
  return detectSubtitleFormatByExtension(filePath) || 'srt';
}

/** 从内容识别常见字幕格式，用于兼容扩展名被改成 .txt 的时间轴字幕。 */
export function detectSubtitleContentFormat(
  content: string,
): SubtitleFormat | null {
  const text = normalizeLineEndings(content || '').trimStart();
  if (!text.trim()) return null;

  if (/^WEBVTT(?:\s|$)/i.test(text)) return 'vtt';
  if (/^\[Script Info\]/im.test(text) || /^\[Events\]/im.test(text)) {
    return 'ass';
  }
  if (/^\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(text)) {
    return 'lrc';
  }

  const timingLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => TIMING_LINE_PATTERN.test(line));

  if (!timingLine) return null;
  if (/,/.test(timingLine)) return 'srt';
  return 'vtt';
}

/**
 * 优先按扩展名识别；当扩展名未知或为 .txt 时，再按内容识别实际时间轴格式。
 * 这样普通 .txt 仍保持 txt 语义，但 WebVTT/SRT 内容误命名为 .txt 时可以导入。
 */
export function detectSubtitleFormatFromContent(
  filePath: string,
  content: string,
): SubtitleFormat {
  const extensionFormat = detectSubtitleFormatByExtension(filePath);
  if (extensionFormat && extensionFormat !== 'txt') return extensionFormat;
  return detectSubtitleContentFormat(content) || extensionFormat || 'srt';
}

/** 获取某格式对应的文件扩展名（含点）。 */
export function getFormatExtension(format: SubtitleFormat): string {
  return FORMAT_TO_EXT[format] || '.srt';
}

export function isSupportedSubtitleFormat(
  format: string,
): format is SubtitleFormat {
  return (SUPPORTED_SUBTITLE_FORMATS as string[]).includes(format);
}

// ----------------------------- 时间处理 -----------------------------

function pad(n: number, len = 2): string {
  return String(Math.max(0, Math.floor(n))).padStart(len, '0');
}

interface TimeParts {
  h: number;
  m: number;
  s: number;
  ms: number;
}

function splitMs(input: number): TimeParts {
  let ms = Math.max(0, Math.round(input));
  const h = Math.floor(ms / 3600000);
  ms -= h * 3600000;
  const m = Math.floor(ms / 60000);
  ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  ms -= s * 1000;
  return { h, m, s, ms };
}

/**
 * 将各种字幕时间字符串解析为毫秒。
 * 支持：HH:MM:SS,mmm | HH:MM:SS.mmm | H:MM:SS.cc(ASS 厘秒) | MM:SS.xx | [mm:ss.xx](LRC)
 */
export function parseTimeToMs(raw: string): number {
  if (!raw) return 0;
  let s = raw.trim();
  // 去除 LRC 方括号
  s = s.replace(/^\[/, '').replace(/\]$/, '');
  // 逗号统一成点
  s = s.replace(',', '.');
  const parts = s.split(':');
  let h = 0;
  let m = 0;
  let sec = 0;
  if (parts.length === 3) {
    h = parseInt(parts[0], 10) || 0;
    m = parseInt(parts[1], 10) || 0;
    sec = parseFloat(parts[2]) || 0;
  } else if (parts.length === 2) {
    m = parseInt(parts[0], 10) || 0;
    sec = parseFloat(parts[1]) || 0;
  } else {
    sec = parseFloat(parts[0]) || 0;
  }
  return Math.round((h * 3600 + m * 60 + sec) * 1000);
}

export function formatSrtTime(ms: number): string {
  const t = splitMs(ms);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)},${pad(t.ms, 3)}`;
}

export function formatVttTime(ms: number): string {
  const t = splitMs(ms);
  return `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}.${pad(t.ms, 3)}`;
}

export function formatAssTime(ms: number): string {
  const t = splitMs(ms);
  const cs = Math.floor(t.ms / 10); // ASS 使用厘秒
  return `${t.h}:${pad(t.m)}:${pad(t.s)}.${pad(cs, 2)}`;
}

export function formatLrcTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${pad(minutes)}:${pad(seconds)}.${pad(cs, 2)}`;
}

/** 解析 "HH:MM:SS,mmm --> HH:MM:SS,mmm" 形式的起止时间。 */
export function parseStartEndTime(startEndTime: string): {
  startMs: number;
  endMs: number;
} {
  const parts = (startEndTime || '').split('-->');
  return {
    startMs: parseTimeToMs(parts[0] || ''),
    endMs: parseTimeToMs(parts[1] || ''),
  };
}

/** 生成 SRT 风格的起止时间字符串（应用内部规范）。 */
export function toSrtTimeRange(startMs: number, endMs: number): string {
  return `${formatSrtTime(startMs)} --> ${formatSrtTime(endMs)}`;
}

// ----------------------------- 解析（导入） -----------------------------

const TIMING_LINE_REGEX = /-->/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeLineEndings(text: string): string {
  return stripBom(text).replace(/\r\n?/g, '\n');
}

/** 解析 SRT / VTT（两者块结构一致，时间分隔符不同，统一处理）。 */
function parseSrtVtt(content: string): SubtitleCue[] {
  let text = normalizeLineEndings(content);
  // 去除 VTT 头部（WEBVTT 行及其后元数据，直到首个空行）
  if (/^WEBVTT/.test(text)) {
    const firstBlank = text.indexOf('\n\n');
    text = firstBlank >= 0 ? text.slice(firstBlank + 2) : '';
  }
  const blocks = text.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    // VTT 的 NOTE / STYLE / REGION 块跳过
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const timingIndex = lines.findIndex((l) => TIMING_LINE_REGEX.test(l));
    if (timingIndex === -1) continue;
    const timingLine = lines[timingIndex];
    const [startPart, endPartRaw] = timingLine.split('-->');
    if (endPartRaw === undefined) continue;
    // VTT 时间行尾部可能带 cue setting（如 align:start position:50%），取第一个时间 token
    const endPart = endPartRaw.trim().split(/\s+/)[0];
    const startMs = parseTimeToMs(startPart);
    const endMs = parseTimeToMs(endPart);
    const textLines = lines.slice(timingIndex + 1);
    if (textLines.length === 0) continue;
    cues.push({ startMs, endMs, text: textLines.join('\n') });
  }
  return cues;
}

/** 清理 ASS 文本中的覆盖标签与转义。 */
function cleanAssText(raw: string): string {
  return raw
    .replace(/\{[^}]*\}/g, '') // 覆盖标签 {\...}
    .replace(/\\N/gi, '\n') // 硬换行
    .replace(/\\h/g, ' ') // 硬空格
    .trim();
}

function parseAss(content: string): SubtitleCue[] {
  const lines = normalizeLineEndings(content).split('\n');
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  let formatFields: string[] = [];
  let idxStart = -1;
  let idxEnd = -1;
  let idxText = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inEvents = /^\[events\]$/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;

    if (/^Format\s*:/i.test(trimmed)) {
      formatFields = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((f) => f.trim().toLowerCase());
      idxStart = formatFields.indexOf('start');
      idxEnd = formatFields.indexOf('end');
      idxText = formatFields.indexOf('text');
      continue;
    }

    if (/^Dialogue\s*:/i.test(trimmed)) {
      if (idxText === -1) continue; // 没有 Format 行无法解析
      const body = trimmed.slice(trimmed.indexOf(':') + 1);
      // 文本字段是最后一个且可能包含逗号，因此按字段数限制切分
      const parts = splitWithLimit(body, ',', formatFields.length);
      const startMs = parseTimeToMs(parts[idxStart] || '');
      const endMs = parseTimeToMs(parts[idxEnd] || '');
      const text = cleanAssText(parts[idxText] || '');
      if (!text) continue;
      cues.push({ startMs, endMs, text });
    }
  }
  return cues;
}

/** 按分隔符切分为最多 limit 段，最后一段保留剩余所有内容（含分隔符）。 */
function splitWithLimit(str: string, sep: string, limit: number): string[] {
  if (limit <= 0) return [str];
  const result: string[] = [];
  let rest = str;
  for (let i = 0; i < limit - 1; i++) {
    const idx = rest.indexOf(sep);
    if (idx === -1) {
      result.push(rest);
      rest = '';
      return result;
    }
    result.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  result.push(rest);
  return result;
}

function parseLrc(content: string): SubtitleCue[] {
  const lines = normalizeLineEndings(content).split('\n');
  const tagRegex = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  let offsetMs = 0;
  const entries: { startMs: number; text: string }[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // offset 元数据
    const offsetMatch = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(trimmed);
    if (offsetMatch) {
      offsetMs = parseInt(offsetMatch[1], 10) || 0;
      continue;
    }
    // 跳过其它纯元数据标签，如 [ar:] [ti:] [al:] [by:] [length:]
    if (/^\[[a-z]+:.*\]$/i.test(trimmed)) continue;

    tagRegex.lastIndex = 0;
    const times: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(trimmed)) !== null) {
      const min = parseInt(m[1], 10) || 0;
      const sec = parseFloat(m[2].replace(':', '.')) || 0;
      times.push(min * 60000 + Math.round(sec * 1000));
    }
    if (times.length === 0) continue;
    const lyric = trimmed.replace(tagRegex, '').trim();
    for (const t of times) {
      entries.push({ startMs: t, text: lyric });
    }
  }

  entries.sort((a, b) => a.startMs - b.startMs);
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < entries.length; i++) {
    const startMs = Math.max(0, entries[i].startMs + offsetMs);
    const endMs =
      i + 1 < entries.length
        ? Math.max(startMs, entries[i + 1].startMs + offsetMs)
        : startMs + 4000; // 末行给一个默认时长
    if (entries[i].text === '') continue;
    cues.push({ startMs, endMs, text: entries[i].text });
  }
  return cues;
}

/** 将字幕内容解析为时间轴 cue 列表。 */
export function parseSubtitleCues(
  content: string,
  format: SubtitleFormat,
): SubtitleCue[] {
  switch (format) {
    case 'ass':
      return parseAss(content);
    case 'lrc':
      return parseLrc(content);
    case 'txt':
      return []; // 纯文本无时间轴，不支持导入
    case 'srt':
    case 'vtt':
    default:
      return parseSrtVtt(content);
  }
}

/** 将字幕内容解析为应用内部的 Subtitle 列表。 */
export function parseSubtitleEntries(
  content: string,
  format: SubtitleFormat,
): SubtitleEntry[] {
  const cues = parseSubtitleCues(content, format);
  return cues.map((cue, index) => ({
    id: String(index + 1),
    startEndTime: toSrtTimeRange(cue.startMs, cue.endMs),
    content: cue.text.split('\n'),
  }));
}

// ----------------------------- 序列化（导出） -----------------------------

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
Collisions: Normal
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,1,2,30,30,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

/** 文件头（仅 vtt/ass 需要），用于流式追加写入前先写头部。 */
export function getSubtitleFileHeader(format: SubtitleFormat): string {
  if (format === 'vtt') return 'WEBVTT\n\n';
  if (format === 'ass') return ASS_HEADER;
  return '';
}

/** 序列化单条 cue（用于流式追加写入）。 */
export function serializeCue(
  cue: { id?: string; startMs: number; endMs: number; text: string },
  format: SubtitleFormat,
): string {
  const text = (cue.text || '').trim();
  switch (format) {
    case 'vtt':
      return `${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${text}\n\n`;
    case 'ass':
      return `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(
        cue.endMs,
      )},Default,,0,0,0,,${text.replace(/\n/g, '\\N')}\n`;
    case 'lrc':
      return `[${formatLrcTime(cue.startMs)}]${text.replace(/\n/g, ' ')}\n`;
    case 'txt':
      return `${text}\n\n`;
    case 'srt':
    default:
      return `${cue.id ?? ''}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(
        cue.endMs,
      )}\n${text}\n\n`;
  }
}

/** 整文件序列化 cue 列表。 */
export function serializeSubtitleCues(
  cues: SubtitleCue[],
  format: SubtitleFormat,
): string {
  const header = getSubtitleFileHeader(format);
  const body = cues
    .map((cue, index) =>
      serializeCue({ ...cue, id: String(index + 1) }, format),
    )
    .join('');
  return header + body;
}

/**
 * 将「已渲染好文本」的条目列表序列化为目标格式整文件。
 * 用于导出已合并好的（含双语）字幕。
 */
export function serializeSubtitleEntries(
  entries: { id?: string; startEndTime: string; text: string }[],
  format: SubtitleFormat,
): string {
  const header = getSubtitleFileHeader(format);
  const body = entries
    .map((entry, index) => {
      const { startMs, endMs } = parseStartEndTime(entry.startEndTime);
      return serializeCue(
        { id: entry.id ?? String(index + 1), startMs, endMs, text: entry.text },
        format,
      );
    })
    .join('');
  return header + body;
}

/** 在不同字幕格式之间转换整文件内容。 */
export function convertSubtitleContent(
  content: string,
  fromFormat: SubtitleFormat,
  toFormat: SubtitleFormat,
): string {
  const cues = parseSubtitleCues(content, fromFormat);
  return serializeSubtitleCues(cues, toFormat);
}

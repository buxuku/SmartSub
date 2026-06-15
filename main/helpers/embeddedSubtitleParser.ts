/**
 * 内封软字幕：纯解析逻辑（无 ffmpeg / 无 electron 依赖，便于单测）。
 * 仅负责：容器扩展名预过滤、ffmpeg stderr 字幕流解析、SRT 是否含字幕块判定。
 */

export interface EmbeddedSubtitleStream {
  /** 字幕流相对序号（第几条 Subtitle 行，从 0 起），用于 ffmpeg -map 0:s:N */
  subIndex: number;
  /** 小写编码名，如 subrip / ass / mov_text / hdmv_pgs_subtitle */
  codec: string;
  /** 语言标签（如 eng / chi）；缺失或 und 时为 undefined */
  language?: string;
  /** 是否为可直接转 SRT 的文本字幕 */
  isText: boolean;
  isDefault: boolean;
  isForced: boolean;
}

/** 可能内封文本软字幕的容器扩展名（不含点、小写） */
export const EMBEDDED_SUBTITLE_CONTAINERS = new Set([
  'mkv',
  'webm',
  'mp4',
  'm4v',
  'mov',
  'ts',
  'm2ts',
  'mts',
  'ogm',
  'ogv',
]);

/** 可直接 -c:s srt 转写的文本字幕编码 */
export const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text',
]);

/** 扩展名预过滤：仅对可能内封字幕的容器才值得 spawn 探测 */
export function canHaveEmbeddedSubtitle(ext: string): boolean {
  if (!ext) return false;
  return EMBEDDED_SUBTITLE_CONTAINERS.has(ext.replace(/^\./, '').toLowerCase());
}

const SUBTITLE_LINE =
  /Stream #\d+:(\d+)(?:\[0x[0-9a-fA-F]+\])?(?:\(([^)]*)\))?:\s*Subtitle:\s*([A-Za-z0-9_]+)/;

/** 解析 `ffmpeg -i` 的 stderr，按出现顺序返回所有字幕流信息 */
export function parseSubtitleStreams(stderr: string): EmbeddedSubtitleStream[] {
  const streams: EmbeddedSubtitleStream[] = [];
  const lines = (stderr || '').split(/\r?\n/);
  let subIndex = 0;
  for (const line of lines) {
    const m = line.match(SUBTITLE_LINE);
    if (!m) continue;
    const lang = m[2];
    const codec = m[3].toLowerCase();
    streams.push({
      subIndex,
      codec,
      language: lang && lang !== 'und' ? lang : undefined,
      isText: TEXT_SUBTITLE_CODECS.has(codec),
      isDefault: /\(default\)/.test(line),
      isForced: /\(forced\)/.test(line),
    });
    subIndex++;
  }
  return streams;
}

/** SRT 是否至少含一条字幕块（用时间码箭头判定，空/全空白为 false） */
export function srtHasCues(content: string): boolean {
  if (!content) return false;
  return /-->/.test(content);
}

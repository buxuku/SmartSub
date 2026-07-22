/**
 * yt-dlp / lux 输出解析（纯函数，无 Electron/Node 依赖，供单测直接编译）。
 */
import type { DownloadEntryMeta } from '../../../types/download';

export interface ParsedProgress {
  /** 0-100 */
  progress?: number;
  speed?: string;
  eta?: string;
}

/** yt-dlp --progress-template 的机器可读前缀（download: 模板） */
export const YTDLP_PROGRESS_PREFIX = 'SMARTSUB-DL;';

/**
 * yt-dlp 进度模板（--newline 下逐行输出）：
 * `SMARTSUB-DL;  12.3%; 3.21MiB/s;00:41`
 */
export const YTDLP_PROGRESS_TEMPLATE = `${YTDLP_PROGRESS_PREFIX}%(progress._percent_str)s;%(progress._speed_str)s;%(progress._eta_str)s`;

export function parseYtDlpProgressLine(line: string): ParsedProgress | null {
  const idx = line.indexOf(YTDLP_PROGRESS_PREFIX);
  if (idx < 0) return null;
  const parts = line
    .slice(idx + YTDLP_PROGRESS_PREFIX.length)
    .split(';')
    .map((s) => s.trim());
  if (parts.length < 3) return null;
  const percent = parseFloat(parts[0].replace('%', ''));
  const result: ParsedProgress = {};
  if (Number.isFinite(percent)) {
    result.progress = Math.min(Math.max(percent, 0), 100);
  }
  // yt-dlp 未知值输出 "Unknown"/"N/A"，透传无意义
  if (parts[1] && !/unknown|n\/a/i.test(parts[1])) result.speed = parts[1];
  if (parts[2] && !/unknown|n\/a/i.test(parts[2])) result.eta = parts[2];
  return result.progress === undefined ? null : result;
}

interface YtDlpJsonFormat {
  height?: number | null;
}

interface YtDlpJson {
  _type?: string;
  title?: string;
  duration?: number;
  thumbnail?: string;
  entries?: Array<{ url?: string; title?: string; id?: string }>;
  formats?: YtDlpJsonFormat[];
  filesize_approx?: number;
  /** 官方（人工上传）字幕：键为语言代码；automatic_captions 有意不读 */
  subtitles?: Record<string, unknown>;
}

/** yt-dlp 把直播聊天回放也塞进 subtitles，非字幕语言，剔除 */
const NON_LANG_SUBTITLE_KEYS = new Set(['live_chat', 'rechat']);

/** yt-dlp -J（--flat-playlist）输出 → 预检元数据 */
export function parseYtDlpPreflightJson(raw: string): DownloadEntryMeta {
  const data = JSON.parse(raw) as YtDlpJson;
  const meta: DownloadEntryMeta = {};
  if (data.title) meta.title = data.title;
  if (typeof data.duration === 'number') meta.duration = data.duration;
  if (data.thumbnail) meta.thumbnail = data.thumbnail;
  if (typeof data.filesize_approx === 'number') {
    meta.totalBytes = data.filesize_approx;
  }
  if (data._type === 'playlist' && Array.isArray(data.entries)) {
    meta.playlistCount = data.entries.length;
    meta.playlistItems = data.entries
      .filter((e) => typeof e?.url === 'string' && e.url)
      .map((e) => ({ url: e.url as string, title: e.title }));
  }
  if (Array.isArray(data.formats)) {
    const heights = Array.from(
      new Set(
        data.formats
          .map((f) => f?.height)
          .filter((h): h is number => typeof h === 'number' && h > 0),
      ),
    ).sort((a, b) => b - a);
    if (heights.length) meta.heights = heights;
  }
  if (data.subtitles && typeof data.subtitles === 'object') {
    const langs = Object.keys(data.subtitles)
      .filter((lang) => !NON_LANG_SUBTITLE_KEYS.has(lang))
      .sort();
    if (langs.length) meta.subtitleLangs = langs;
  }
  return meta;
}

/** 认领的字幕扩展名白名单（--convert-subs srt 失败时保留 vtt/ass 原格式） */
const CLAIMABLE_SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass'];

/**
 * 按视频文件名认领同目录字幕文件（纯函数，入参出参均为 basename）。
 * 规则对齐向导配对语义：字幕主干 = 视频主干 + `.语言` 前缀
 * （yt-dlp --write-subs 固定产出 `主干.lang.srt`，裸 `主干.srt` 不认领），
 * 扩展名白名单剔除 live_chat.json 等非字幕产物；结果排序保证确定性。
 */
export function claimSubtitleFileNames(
  videoFileName: string,
  candidateFileNames: string[],
): string[] {
  const videoStem = videoFileName.replace(/\.[^.]+$/, '');
  if (!videoStem) return [];
  const prefix = `${videoStem}.`;
  return candidateFileNames
    .filter((name) => {
      if (name === videoFileName) return false;
      const extMatch = name.match(/\.[^.]+$/);
      if (
        !extMatch ||
        !CLAIMABLE_SUBTITLE_EXTENSIONS.includes(extMatch[0].toLowerCase())
      ) {
        return false;
      }
      const stem = name.slice(0, -extMatch[0].length);
      return stem.startsWith(prefix);
    })
    .sort((a, b) => a.localeCompare(b));
}

interface LuxStreamPart {
  size?: number;
}

interface LuxStream {
  size?: number;
  parts?: LuxStreamPart[];
}

interface LuxJson {
  title?: string;
  streams?: Record<string, LuxStream>;
}

/** lux -j 输出（JSON 数组）→ 预检元数据（取首个媒体项 + 最大流体积） */
export function parseLuxPreflightJson(raw: string): DownloadEntryMeta {
  const parsed = JSON.parse(raw) as LuxJson[] | LuxJson;
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const meta: DownloadEntryMeta = {};
  if (!item) return meta;
  if (item.title) meta.title = item.title;
  const streams = item.streams ? Object.values(item.streams) : [];
  let maxSize = 0;
  for (const stream of streams) {
    const size =
      typeof stream?.size === 'number' && stream.size > 0
        ? stream.size
        : (stream?.parts || []).reduce((sum, p) => sum + (p?.size || 0), 0);
    if (size > maxSize) maxSize = size;
  }
  if (maxSize > 0) meta.totalBytes = maxSize;
  if (Array.isArray(parsed) && parsed.length > 1) {
    meta.playlistCount = parsed.length;
  }
  return meta;
}

/**
 * lux stdout 进度解析：进度条文本形如
 * ` 1.10 MiB / 720.00 MiB [>----] 0.15% 3.20 MiB/s 00m41s`。
 * 输出随版本可能漂移，解析失败由调用方降级为文件大小轮询。
 */
export function parseLuxProgressChunk(chunk: string): ParsedProgress | null {
  const percentMatches = chunk.match(/(\d{1,3}(?:\.\d+)?)\s*%/g);
  if (!percentMatches?.length) return null;
  const last = percentMatches[percentMatches.length - 1];
  const percent = parseFloat(last);
  if (!Number.isFinite(percent)) return null;
  const result: ParsedProgress = {
    progress: Math.min(Math.max(percent, 0), 100),
  };
  const speedMatch = chunk.match(/([\d.]+\s*[KMG]i?B\/s)/i);
  if (speedMatch) result.speed = speedMatch[1].replace(/\s+/, '');
  return result;
}

/**
 * lux 的 DASH 分片文件名（`名[0].mp4` / `名[1].m4a`）：ffmpeg 合并前的中间产物。
 * baseName 已知时要求前缀匹配（精确认领）；未知时按 `[个位/十位数字]` 结尾启发式判定
 * （yt-dlp 的 `[BV…]` id 后缀含字母，不会误命中）。
 */
export function isLuxPartFileName(
  fileName: string,
  baseName?: string | null,
): boolean {
  const stem = fileName.replace(/\.[^.]+$/, '');
  if (!/\[\d{1,2}\]$/.test(stem)) return false;
  return baseName ? stem.startsWith(baseName) : true;
}

/** 引擎报错是否疑似「下载器版本过旧」（提取器失效类），驱动更新引导 */
export function isLikelyOutdatedEngineError(message: string): boolean {
  return /unsupported url|unable to extract|extractor|not supported|无法|不支持|failed to parse|panic:/i.test(
    message,
  );
}

/**
 * 引擎报错是否疑似「登录态/权限」问题（cookie 失效或未登录），驱动重新导入引导。
 * 仅在本次执行附带了 cookie 时用于加 MAYBE_COOKIE_EXPIRED 前缀（见 scheduler）。
 * 关键词避开与 isLikelyOutdatedEngineError 的「提取器失效」语义重叠。
 */
export function isLikelyAuthError(message: string): boolean {
  return /\b(401|403)\b|http error 4(01|03)|forbidden|login|log ?in|sign ?in|members[- ]only|member.only|premium|account|cookies?|需要登录|请登录|登录后|大会员|会员|付费|权限/i.test(
    message,
  );
}

/** 进程 stderr 尾部裁剪为可展示的错误信息 */
export function tailForError(output: string, maxLength = 300): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 优先取包含 ERROR 的行（yt-dlp 约定），否则取最后几行
  const errorLines = lines.filter((l) => /error/i.test(l));
  const chosen = (errorLines.length ? errorLines : lines).slice(-3).join(' | ');
  return chosen.length > maxLength ? chosen.slice(-maxLength) : chosen;
}

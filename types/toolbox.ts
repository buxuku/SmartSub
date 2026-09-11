/**
 * 音视频与字幕周边工具箱（Toolbox）核心类型定义
 */

export type ToolCategory = 'all' | 'subtitles' | 'video' | 'audio';

export type ToolboxToolId =
  | 'subtitle-converter'
  | 'video-trimmer'
  | 'audio-extractor'
  | 'embedded-subtitles'
  | 'subtitle-sync'
  | 'bilingual-subtitles'
  | 'video-compressor'
  | 'video-to-gif';

export interface ToolboxToolManifest {
  id: ToolboxToolId;
  nameKey: string;
  descKey: string;
  category: ToolCategory;
  icon: string;
  badgeKey?: string;
  phase: 1 | 2 | 3;
}

// ----------------- 字符编码与字幕转换 -----------------

export interface EncodingDetectResult {
  encoding: string;
  hasBom: boolean;
  confidence: number;
  sampleText: string;
}

export type ChineseConvertMode =
  | 'none'
  | 's2t'
  | 't2s'
  | 's2tw'
  | 'tw2s'
  | 's2hk'
  | 'hk2s';

export interface SubtitleConvertItemConfig {
  filePath: string;
  targetFormat: 'srt' | 'vtt' | 'ass' | 'lrc' | 'txt';
  sourceEncoding?: string; // 'auto' or 'utf-8', 'gb18030', etc.
  targetEncoding?: 'utf-8' | 'utf-8-bom' | 'gb18030';
  chineseConversion?: ChineseConvertMode;
  cleanFormatting?: boolean;
  includeTimestampsInTxt?: boolean;
  outputDir?: string;
}

export interface SubtitleConvertItemResult {
  success: boolean;
  sourcePath: string;
  outputPath?: string;
  format?: string;
  count?: number;
  detectedEncoding?: string;
  error?: string;
}

// ----------------- 视频裁剪 -----------------

export interface VideoTrimConfig {
  videoPath: string;
  startSec: number;
  endSec: number;
  mode: 'lossless' | 'accurate';
  outputPath?: string;
  outputDir?: string;
}

export interface VideoTrimProgress {
  percent: number;
  currentTime?: number;
  timemark?: string;
}

export interface VideoTrimResult {
  success: boolean;
  outputPath: string;
  duration: number;
  size: number;
  error?: string;
}

// ----------------- 音频提取 -----------------

export type AudioExtractFormat = 'mp3' | 'wav' | 'aac' | 'm4a' | 'flac';

export interface AudioExtractConfig {
  videoPath: string;
  format: AudioExtractFormat;
  bitrate?: '128k' | '192k' | '256k' | '320k';
  wavPreset?: 'standard' | 'asr_16k_mono';
  outputPath?: string;
}

export interface AudioExtractResult {
  success: boolean;
  outputPath: string;
  format: string;
  size: number;
  error?: string;
}

// ----------------- 内封软字幕提取 -----------------

export interface EmbeddedSubtitleStreamInfo {
  subIndex: number;
  codec: string;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
  isText: boolean;
}

export interface ExtractEmbeddedSubtitleConfig {
  videoPath: string;
  streamIndices: number[]; // subIndex array
  targetFormat: 'srt' | 'ass' | 'vtt';
  outputDir?: string;
}

export interface ExtractEmbeddedSubtitleResult {
  success: boolean;
  extractedFiles: Array<{
    subIndex: number;
    outputPath: string;
    language?: string;
  }>;
  error?: string;
}

// ----------------- 字幕时间轴校准 -----------------

export type SubtitleSyncMode = 'offset' | 'scale' | 'two-point';

export interface SubtitleSyncConfig {
  filePath: string;
  mode: SubtitleSyncMode;
  offsetMs?: number;
  scaleRatio?: number;
  p1SourceMs?: number;
  p1TargetMs?: number;
  p2SourceMs?: number;
  p2TargetMs?: number;
  outputPath?: string;
}

export interface SubtitleSyncResult {
  success: boolean;
  outputPath: string;
  cuesCount: number;
  error?: string;
}

// ----------------- 双语字幕合并与拆分 -----------------

export interface BilingualSubtitleMergeConfig {
  primaryPath: string;
  secondaryPath: string;
  primaryPosition: 'top' | 'bottom';
  separator?: string;
  outputPath?: string;
}

export interface BilingualSubtitleSplitConfig {
  filePath: string;
  outputDir?: string;
}

export interface BilingualSubtitleResult {
  success: boolean;
  outputPaths: string[];
  cuesCount: number;
  error?: string;
}

// ----------------- 视频压缩 -----------------

export type VideoCompressPreset =
  | 'wechat_25mb'
  | 'balanced_1080p'
  | 'fast_720p'
  | 'target_size';

export interface VideoCompressConfig {
  videoPath: string;
  preset: VideoCompressPreset;
  targetSizeMb?: number;
  outputPath?: string;
}

export interface VideoCompressResult {
  success: boolean;
  outputPath: string;
  originalSize: number;
  compressedSize: number;
  error?: string;
}

// ----------------- 视频转 GIF -----------------

export interface VideoToGifConfig {
  videoPath: string;
  startSec: number;
  endSec: number;
  fps?: number; // 10, 12, 15
  width?: number; // 360, 480, 640
  outputPath?: string;
}

export interface VideoToGifResult {
  success: boolean;
  outputPath: string;
  size: number;
  error?: string;
}

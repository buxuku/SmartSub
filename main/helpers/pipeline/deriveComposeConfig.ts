/**
 * 流水线合成阶段的矩阵推导（纯函数，fs/平台注入，可单测）。
 *
 * 规则（spec pipeline-compose-stage）：
 * - 有配音轨 → audio=replace；无配音 → audio=keep
 * - 烧录字幕优先级：顺延版字幕（配音时移时产出）→ 译文交付物 → 源字幕
 * - subtitle='none' 要求存在配音轨（否则无事可做，配置错误）
 * - 输出 `<原名>-final.<ext>`（防覆盖递增）；soft 参与强制 mkv
 */

import * as path from 'path';
import type {
  ComposeConfig,
  EncoderMode,
  SubtitleStyle,
  VideoQuality,
} from '../../../types/subtitleMerge';
import type { IFiles, PipelineComposeConfig } from '../../../types';

/** 主进程侧默认烧录样式（与渲染层 DEFAULT_STYLE 同值，字体按平台注入） */
export const DEFAULT_PIPELINE_STYLE: Omit<SubtitleStyle, 'fontName'> = {
  fontSize: 24,
  primaryColor: '#FFFFFF',
  outlineColor: '#000000',
  backColor: '#000000',
  backOpacity: 50,
  bold: false,
  italic: false,
  underline: false,
  borderStyle: 1,
  outline: 2,
  shadow: 1,
  alignment: 2,
  marginL: 20,
  marginR: 20,
  marginV: 20,
};

export function platformDefaultFont(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'PingFang SC';
  if (platform === 'win32') return 'Microsoft YaHei';
  return 'Noto Sans CJK SC';
}

/**
 * 合成阶段生效参数解析：任务快照（向导选择的样式/画质/编码）优先，
 * 回退全局合成偏好，最后回退默认值。快照样式与默认样式浅合并，
 * 兼容旧快照/配方缺字段（后续样式新增字段有默认兜底）。
 */
export function resolveComposeRunOptions(
  compose: Pick<
    PipelineComposeConfig,
    'style' | 'videoQuality' | 'encoderMode'
  >,
  prefs: { videoQuality?: VideoQuality; encoderMode?: EncoderMode } | undefined,
  platform: NodeJS.Platform,
): {
  style: SubtitleStyle;
  videoQuality: VideoQuality;
  encoderMode: EncoderMode;
} {
  return {
    style: {
      ...DEFAULT_PIPELINE_STYLE,
      fontName: platformDefaultFont(platform),
      ...(compose.style ?? {}),
    },
    videoQuality: compose.videoQuality ?? prefs?.videoQuality ?? 'original',
    encoderMode: compose.encoderMode ?? prefs?.encoderMode ?? 'cpu',
  };
}

function isPlainText(p?: string): boolean {
  return /\.txt$/i.test(p || '');
}

/** 烧录/软封字幕的取用优先级：顺延版 → 译文交付物 → 源字幕（txt 不可用） */
export function pickComposeSubtitle(
  file: Pick<
    IFiles,
    | 'shiftedSubtitlePath'
    | 'translatedSrtFile'
    | 'srtFile'
    | 'tempSrtFile'
    | 'filePath'
  >,
  exists: (p: string) => boolean,
  isSubtitleInput: boolean,
): string | null {
  const candidates = [
    file.shiftedSubtitlePath,
    file.translatedSrtFile,
    file.srtFile,
    file.tempSrtFile,
    isSubtitleInput ? file.filePath : undefined,
  ];
  for (const candidate of candidates) {
    if (candidate && !isPlainText(candidate) && exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** `<原名>-final.<ext>`，已存在时 `-final-2`、`-final-3` 递增 */
export function finalOutputPath(
  videoPath: string,
  ext: string,
  exists: (p: string) => boolean,
): string {
  const dir = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath));
  let candidate = path.join(dir, `${stem}-final${ext}`);
  let n = 2;
  while (exists(candidate)) {
    candidate = path.join(dir, `${stem}-final-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

export interface DeriveComposeInput {
  file: Pick<
    IFiles,
    | 'filePath'
    | 'fileExtension'
    | 'dubbedTrackPath'
    | 'shiftedSubtitlePath'
    | 'translatedSrtFile'
    | 'srtFile'
    | 'tempSrtFile'
  >;
  compose: PipelineComposeConfig;
  style: SubtitleStyle;
  videoQuality?: VideoQuality;
  encoderMode?: EncoderMode;
  exists: (p: string) => boolean;
}

export type DeriveComposeResult =
  | { ok: true; config: ComposeConfig }
  | { ok: false; reason: 'no-subtitle' | 'none-without-dub' };

export function deriveComposeConfig(
  input: DeriveComposeInput,
): DeriveComposeResult {
  const { file, compose, style, videoQuality, encoderMode, exists } = input;
  const dubbedTrack =
    file.dubbedTrackPath && exists(file.dubbedTrackPath)
      ? file.dubbedTrackPath
      : null;

  const audio: ComposeConfig['audio'] = dubbedTrack
    ? { mode: 'replace', trackPath: dubbedTrack }
    : { mode: 'keep' };

  let subtitle: ComposeConfig['subtitle'];
  if (compose.subtitle === 'none') {
    if (!dubbedTrack) return { ok: false, reason: 'none-without-dub' };
    subtitle = { mode: 'none' };
  } else {
    const subtitlePath = pickComposeSubtitle(file, exists, false);
    if (!subtitlePath) return { ok: false, reason: 'no-subtitle' };
    subtitle =
      compose.subtitle === 'soft'
        ? { mode: 'soft', subtitlePath }
        : {
            mode: 'hard',
            subtitlePath,
            style,
            videoQuality,
            encoderMode,
          };
  }

  // 容器：沿用源扩展名；soft 参与强制 mkv（addTrack P2 不参与）
  const sourceExt = path.extname(file.filePath) || '.mp4';
  const ext = subtitle.mode === 'soft' ? '.mkv' : sourceExt;
  const outputPath = finalOutputPath(file.filePath, ext, exists);

  return {
    ok: true,
    config: { videoPath: file.filePath, outputPath, subtitle, audio },
  };
}

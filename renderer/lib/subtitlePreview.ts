/**
 * 校对台播放器的字幕预览：由编辑器内存文档（Subtitle 行）直接生成 WebVTT。
 *
 * 预览必须是文档的投影，而不是磁盘文件的快照：
 *   - 编辑、撤销、合并、拆分、改时间后，预览跟随文档，不依赖保存；
 *   - 不依赖磁盘上的 SRT 是否存在 / 是否与 sidecar 一致；
 *   - 不依赖可选的语言元数据（文件名检测可能为空）。
 *
 * 取值规则与保存路径（main/helpers/proofreadData.ts）一致：
 *   原文取 sourceContent，缺失时回退 content 行；译文取 targetContent。
 * 序列化复用 main/helpers/subtitleFormats（零依赖纯函数），
 * 与原先磁盘 SRT → VTT 转换使用同一套 VTT 格式化。
 */

import {
  parseStartEndTime,
  serializeSubtitleCues,
  type SubtitleCue,
} from '../../main/helpers/subtitleFormats';
import type { Subtitle } from '../hooks/useSubtitles';

export type PreviewField = 'sourceContent' | 'targetContent';
export type PreviewTrackRole = 'source' | 'target';

type PreviewRow = Pick<
  Subtitle,
  | 'startEndTime'
  | 'content'
  | 'sourceContent'
  | 'targetContent'
  | 'startTimeInSeconds'
  | 'endTimeInSeconds'
>;

export interface PreviewLanguages {
  source?: string;
  target?: string;
}

export interface PreviewTrackSpec {
  role: PreviewTrackRole;
  vtt: string;
  srcLang: string;
  label: string;
  default: boolean;
}

// 语言缺失时使用的 BCP 47 「未确定」标签
const UNDETERMINED_LANGUAGE = 'und';

const secondsToMs = (seconds: number | undefined): number | null =>
  typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.round(seconds * 1000)
    : null;

// 编辑操作同步维护秒数与 startEndTime；秒数缺失时回退到时间字符串
const rowRange = (row: PreviewRow): { startMs: number; endMs: number } => {
  const startMs = secondsToMs(row.startTimeInSeconds);
  const endMs = secondsToMs(row.endTimeInSeconds);
  if (startMs !== null && endMs !== null) return { startMs, endMs };
  return parseStartEndTime(row.startEndTime);
};

const rowText = (row: PreviewRow, field: PreviewField): string =>
  field === 'sourceContent'
    ? (row.sourceContent ?? row.content?.join('\n') ?? '')
    : (row.targetContent ?? '');

// WebVTT cue 文本不能含空行（会截断 cue），也不能含 `-->`（会被当成时间行）
const cueText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n')
    .replace(/-->/g, '--&gt;');

/** 把某一列文本生成 WebVTT；没有任何可显示的 cue 时返回 null。 */
export function buildPreviewVtt(
  rows: readonly PreviewRow[],
  field: PreviewField,
): string | null {
  const cues: SubtitleCue[] = [];
  for (const row of rows) {
    const text = cueText(rowText(row, field));
    if (!text) continue;
    const { startMs, endMs } = rowRange(row);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs <= startMs
    )
      continue;
    cues.push({ startMs, endMs, text });
  }
  return cues.length > 0 ? serializeSubtitleCues(cues, 'vtt') : null;
}

const trackSpec = (
  role: PreviewTrackRole,
  vtt: string,
  language: string,
  isDefault: boolean,
): PreviewTrackSpec => ({
  role,
  vtt,
  srcLang: language || UNDETERMINED_LANGUAGE,
  label: language ? `(${language})` : role,
  default: isDefault,
});

/**
 * 生成播放器的原文 / 译文两条轨道。
 * 有译文文本时默认显示译文，否则默认显示原文；语言只用于标签，缺失不影响生成。
 */
export function buildPreviewTrackSpecs(
  rows: readonly PreviewRow[],
  languages: PreviewLanguages = {},
): PreviewTrackSpec[] {
  const sourceVtt = buildPreviewVtt(rows, 'sourceContent');
  const targetVtt = buildPreviewVtt(rows, 'targetContent');
  const specs: PreviewTrackSpec[] = [];
  if (sourceVtt)
    specs.push(
      trackSpec(
        'source',
        sourceVtt,
        languages.source?.trim() ?? '',
        !targetVtt,
      ),
    );
  if (targetVtt)
    specs.push(
      trackSpec('target', targetVtt, languages.target?.trim() ?? '', true),
    );
  return specs;
}

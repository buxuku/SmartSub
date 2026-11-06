/**
 * 字幕时间轴校准与漂移修复服务
 *
 * 支持三类常用校准算法：
 * 1. 整体平移（加减 offsetMs）；
 * 2. 帧率比例伸缩（乘 scaleRatio，如 24/25 或 25/24 消除线性漂移）；
 * 3. 首尾双锚点重采样（根据首句和尾句的实际时刻线性内插修正）。
 */

import fs from 'fs';
import { reserveToolboxOutput, writeToolboxOutput } from './outputPath';
import path from 'path';
import {
  FRAMERATE_RATIO_PRESETS,
  scaleTimestampMs,
} from '../../../types/framerates';
import { decodeBufferToString, encodeStringToBuffer } from './encodingDetector';
import {
  detectSubtitleFormatFromContent,
  parseSubtitleCues,
  serializeSubtitleCues,
  type SubtitleCue,
  type SubtitleFormat,
} from '../subtitleFormats';
import type {
  SubtitleSyncConfig,
  SubtitleSyncResult,
} from '../../../types/toolbox';

export function syncCues(
  cues: SubtitleCue[],
  config: SubtitleSyncConfig,
): SubtitleCue[] {
  const {
    mode,
    offsetMs = 0,
    scaleRatio = 1,
    p1SourceMs = 0,
    p1TargetMs = 0,
    p2SourceMs = 1,
    p2TargetMs = 1,
  } = config;
  if (mode === 'scale' && (!Number.isFinite(scaleRatio) || scaleRatio <= 0))
    throw new Error('Scale ratio must be positive and finite');
  const fraction =
    config.scaleFraction ||
    FRAMERATE_RATIO_PRESETS.find((preset) => preset.ratio === scaleRatio)
      ?.fraction;
  const scale = (ms: number) =>
    fraction ? scaleTimestampMs(ms, fraction) : Math.round(ms * scaleRatio);
  if (mode === 'offset' && !Number.isFinite(offsetMs))
    throw new Error('Offset must be finite');
  if (
    mode === 'two-point' &&
    (![p1SourceMs, p1TargetMs, p2SourceMs, p2TargetMs].every(Number.isFinite) ||
      p2SourceMs <= p1SourceMs ||
      p2TargetMs <= p1TargetMs)
  )
    throw new Error('Anchor timestamps must be finite and increasing');

  return cues.map((cue) => {
    let newStart = cue.startMs;
    let newEnd = cue.endMs;

    if (mode === 'offset') {
      newStart = Math.max(0, cue.startMs + offsetMs);
      newEnd = Math.max(newStart + 10, cue.endMs + offsetMs);
    } else if (mode === 'scale') {
      newStart = Math.max(0, scale(cue.startMs));
      newEnd = Math.max(newStart + 10, scale(cue.endMs));
    } else if (mode === 'two-point') {
      const srcRange = p2SourceMs - p1SourceMs;
      const tgtRange = p2TargetMs - p1TargetMs;
      if (srcRange !== 0) {
        const factor = tgtRange / srcRange;
        newStart = Math.max(
          0,
          Math.round(p1TargetMs + (cue.startMs - p1SourceMs) * factor),
        );
        newEnd = Math.max(
          newStart + 10,
          Math.round(p1TargetMs + (cue.endMs - p1SourceMs) * factor),
        );
      }
    }

    return {
      ...cue,
      startMs: newStart,
      endMs: newEnd,
    };
  });
}

export async function executeSubtitleSync(
  config: SubtitleSyncConfig,
): Promise<SubtitleSyncResult> {
  try {
    const { filePath, outputPath } = config;
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        outputPath: '',
        cuesCount: 0,
        error: `File not found: ${filePath}`,
      };
    }

    const buffer = await fs.promises.readFile(filePath);
    const { text, detectedEncoding } = decodeBufferToString(buffer);
    const format = detectSubtitleFormatFromContent(filePath, text);
    const cues = parseSubtitleCues(text, format);

    if (cues.length === 0) {
      return {
        success: false,
        outputPath: '',
        cuesCount: 0,
        error: 'No valid subtitle cues found',
      };
    }

    const updatedCues = syncCues(cues, config);
    const outputContent = serializeSubtitleCues(
      updatedCues,
      format as SubtitleFormat,
    );

    const dir = outputPath ? path.dirname(outputPath) : path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);

    const targetOutput = reserveToolboxOutput(
      outputPath || path.join(dir, `${baseName}_synced${ext}`),
    );

    const outBuf = encodeStringToBuffer(
      outputContent,
      detectedEncoding.toLowerCase().includes('bom') ? 'utf-8-bom' : 'utf-8',
    );

    await writeToolboxOutput(targetOutput, outBuf);

    return {
      success: true,
      outputPath: targetOutput,
      cuesCount: updatedCues.length,
    };
  } catch (err: any) {
    return {
      success: false,
      outputPath: '',
      cuesCount: 0,
      error: err.message || String(err),
    };
  }
}

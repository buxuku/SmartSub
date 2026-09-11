/**
 * 字幕时间轴校准与漂移修复服务
 *
 * 支持三类常用校准算法：
 * 1. 整体平移（加减 offsetMs）；
 * 2. 帧率比例伸缩（乘 scaleRatio，如 24/25 或 25/24 消除线性漂移）；
 * 3. 首尾双锚点重采样（根据首句和尾句的实际时刻线性内插修正）。
 */

import fs from 'fs';
import path from 'path';
import {
  decodeBufferToString,
  encodeStringToBuffer,
} from './encodingDetector';
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
  const { mode, offsetMs = 0, scaleRatio = 1, p1SourceMs = 0, p1TargetMs = 0, p2SourceMs = 1, p2TargetMs = 1 } = config;

  return cues.map((cue) => {
    let newStart = cue.startMs;
    let newEnd = cue.endMs;

    if (mode === 'offset') {
      newStart = Math.max(0, cue.startMs + offsetMs);
      newEnd = Math.max(newStart + 10, cue.endMs + offsetMs);
    } else if (mode === 'scale') {
      newStart = Math.max(0, Math.round(cue.startMs * scaleRatio));
      newEnd = Math.max(newStart + 10, Math.round(cue.endMs * scaleRatio));
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
    const outputContent = serializeSubtitleCues(updatedCues, format as SubtitleFormat);

    const dir = outputPath ? path.dirname(outputPath) : path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);

    const targetOutput = outputPath || path.join(dir, `${baseName}_synced${ext}`);

    const outBuf = encodeStringToBuffer(
      outputContent,
      detectedEncoding.toLowerCase().includes('bom') ? 'utf-8-bom' : 'utf-8',
    );

    await fs.promises.writeFile(targetOutput, outBuf);

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

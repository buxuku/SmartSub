/**
 * 双语字幕智能合并与拆分服务
 *
 * 1. 合并模式：根据时间轴区间重叠智能对齐两份单语字幕，合成双语字幕文件；
 * 2. 拆分模式：将多行双语字幕智能剥离为两份独立的单语字幕文件。
 */

import fs from 'fs';
import {
  reserveToolboxOutput,
  toolboxOutputDirectory,
  writeToolboxOutput,
} from './outputPath';
import path from 'path';
import { decodeBufferToString, encodeStringToBuffer } from './encodingDetector';
import {
  detectSubtitleFormatFromContent,
  parseSubtitleCues,
  serializeSubtitleCues,
  type SubtitleCue,
  type SubtitleFormat,
} from '../subtitleFormats';
import type {
  BilingualSubtitleMergeConfig,
  BilingualSubtitleSplitConfig,
  BilingualSubtitleResult,
} from '../../../types/toolbox';

export async function mergeBilingualSubtitles(
  config: BilingualSubtitleMergeConfig,
): Promise<BilingualSubtitleResult> {
  try {
    const {
      primaryPath,
      secondaryPath,
      primaryPosition = 'top',
      separator = '\n',
      outputPath,
    } = config;

    if (!fs.existsSync(primaryPath) || !fs.existsSync(secondaryPath)) {
      return {
        success: false,
        outputPaths: [],
        cuesCount: 0,
        error: 'One or both subtitle files not found',
      };
    }

    const pBuf = await fs.promises.readFile(primaryPath);
    const sBuf = await fs.promises.readFile(secondaryPath);

    const pDecoded = decodeBufferToString(pBuf);
    const sDecoded = decodeBufferToString(sBuf);

    const pFormat = detectSubtitleFormatFromContent(primaryPath, pDecoded.text);
    const sFormat = detectSubtitleFormatFromContent(
      secondaryPath,
      sDecoded.text,
    );

    const pCues = parseSubtitleCues(pDecoded.text, pFormat);
    const sCues = parseSubtitleCues(sDecoded.text, sFormat);

    if (pCues.length === 0 || sCues.length === 0) {
      return {
        success: false,
        outputPaths: [],
        cuesCount: 0,
        error: 'One or both subtitle files contain no cues',
      };
    }

    // 针对主字幕的每条条目，匹配时间轴重叠最大的从字幕条目
    const mergedCues: SubtitleCue[] = pCues.map((p) => {
      // 查找与主字幕有时间重合的所有从字幕
      const matches = sCues.filter(
        (s) => s.startMs < p.endMs && s.endMs > p.startMs,
      );

      let secondaryText = '';
      if (matches.length > 0) {
        // 取重合时间最长的条目
        matches.sort((a, b) => {
          const overlapA =
            Math.min(p.endMs, a.endMs) - Math.max(p.startMs, a.startMs);
          const overlapB =
            Math.min(p.endMs, b.endMs) - Math.max(p.startMs, b.startMs);
          return overlapB - overlapA;
        });
        secondaryText = matches[0].text;
      }

      let combinedText = p.text;
      if (secondaryText) {
        combinedText =
          primaryPosition === 'top'
            ? `${p.text}${separator}${secondaryText}`
            : `${secondaryText}${separator}${p.text}`;
      }

      return {
        startMs: p.startMs,
        endMs: p.endMs,
        text: combinedText,
      };
    });

    const dir = outputPath
      ? path.dirname(outputPath)
      : path.dirname(primaryPath);
    const ext = path.extname(primaryPath) || '.srt';
    const baseName = path.basename(primaryPath, ext);

    const desiredOutput =
      outputPath || path.join(dir, `${baseName}_bilingual${ext}`);
    const format = detectSubtitleFormatFromContent(desiredOutput, '');
    const outContent = serializeSubtitleCues(
      mergedCues,
      format as SubtitleFormat,
    );

    const encoded = encodeStringToBuffer(outContent, 'utf-8');
    const targetOutput = reserveToolboxOutput(desiredOutput);
    await writeToolboxOutput(targetOutput, encoded);

    return {
      success: true,
      outputPaths: [targetOutput],
      cuesCount: mergedCues.length,
    };
  } catch (err: any) {
    return {
      success: false,
      outputPaths: [],
      cuesCount: 0,
      error: err.message || String(err),
    };
  }
}

export async function splitBilingualSubtitles(
  config: BilingualSubtitleSplitConfig,
): Promise<BilingualSubtitleResult> {
  try {
    const { filePath, outputDir } = config;
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        outputPaths: [],
        cuesCount: 0,
        error: `File not found: ${filePath}`,
      };
    }

    const buf = await fs.promises.readFile(filePath);
    const decoded = decodeBufferToString(buf);
    const format = detectSubtitleFormatFromContent(filePath, decoded.text);
    const cues = parseSubtitleCues(decoded.text, format);

    if (cues.length === 0) {
      return {
        success: false,
        outputPaths: [],
        cuesCount: 0,
        error: 'No cues found to split',
      };
    }

    const part1Cues: SubtitleCue[] = [];
    const part2Cues: SubtitleCue[] = [];

    for (const cue of cues) {
      const lines = cue.text.split('\n').filter((l) => l.trim() !== '');
      if (lines.length >= 2) {
        part1Cues.push({ ...cue, text: lines[0] });
        part2Cues.push({ ...cue, text: lines.slice(1).join('\n') });
      } else {
        // 单行保持原样
        part1Cues.push(cue);
        part2Cues.push(cue);
      }
    }

    const dir = toolboxOutputDirectory(outputDir, filePath);
    const ext = path.extname(filePath) || '.srt';
    const baseName = path.basename(filePath, ext);

    const content1 = encodeStringToBuffer(
      serializeSubtitleCues(part1Cues, format as SubtitleFormat),
      'utf-8',
    );
    const content2 = encodeStringToBuffer(
      serializeSubtitleCues(part2Cues, format as SubtitleFormat),
      'utf-8',
    );

    const outputs: string[] = [];
    try {
      outputs.push(
        reserveToolboxOutput(path.join(dir, `${baseName}_part1${ext}`)),
      );
      outputs.push(
        reserveToolboxOutput(path.join(dir, `${baseName}_part2${ext}`)),
      );
      await writeToolboxOutput(outputs[0], content1);
      await writeToolboxOutput(outputs[1], content2);
    } catch (error) {
      await Promise.all(
        outputs.map((output) => fs.promises.unlink(output).catch(() => {})),
      );
      throw error;
    }

    return {
      success: true,
      outputPaths: outputs,
      cuesCount: cues.length,
    };
  } catch (err: any) {
    return {
      success: false,
      outputPaths: [],
      cuesCount: 0,
      error: err.message || String(err),
    };
  }
}

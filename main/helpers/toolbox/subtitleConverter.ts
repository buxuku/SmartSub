/**
 * 字幕格式与编码转换核心服务
 *
 * 支持 SRT, VTT, ASS, SSA, LRC, TXT 互转；
 * 跨平台编码探测与修复（UTF-8, UTF-8 BOM, GB18030, Big5）；
 * 简繁中文转换、样式标签剥离与原子文件输出。
 */

import fs from 'fs';
import path from 'path';
import { Converter } from 'opencc-js';
import {
  detectBufferEncoding,
  decodeBufferToString,
  encodeStringToBuffer,
} from './encodingDetector';
import {
  detectSubtitleFormatFromContent,
  parseSubtitleCues,
  serializeSubtitleCues,
  formatSrtTime,
  type SubtitleCue,
  type SubtitleFormat,
} from '../subtitleFormats';
import type {
  SubtitleConvertItemConfig,
  SubtitleConvertItemResult,
  ChineseConvertMode,
  EncodingDetectResult,
} from '../../../types/toolbox';

// 缓存 OpenCC 转换器实例，避免重复创建开销
const converterCache: Partial<Record<ChineseConvertMode, (s: string) => string>> = {};

function getOpenCCConverter(mode: ChineseConvertMode): ((s: string) => string) | null {
  if (mode === 'none') return null;
  if (converterCache[mode]) return converterCache[mode]!;

  const modeMap: Record<Exclude<ChineseConvertMode, 'none'>, [string, string]> = {
    s2t: ['cn', 't'],
    t2s: ['t', 'cn'],
    s2tw: ['cn', 'tw'],
    tw2s: ['tw', 'cn'],
    s2hk: ['cn', 'hk'],
    hk2s: ['hk', 'cn'],
  };

  const [from, to] = modeMap[mode];
  const cv = Converter({ from: from as any, to: to as any });
  converterCache[mode] = cv;
  return cv;
}

/** 清除文本中的 ASS 覆盖标签及 HTML 格式标签 */
export function cleanSubtitleFormatting(text: string): string {
  if (!text) return '';
  return text
    .replace(/\{[^}]*\}/g, '') // 移除 ASS {\an8} {\pos(..)} 等样式
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // 移除 <i> <b> <font color="..."> 等 HTML/VTT 标签
    .replace(/\\N/gi, '\n') // 转换 ASS 硬换行
    .replace(/\\h/g, ' ') // 转换 ASS 硬空格
    .trim();
}

/**
 * 探测指定字幕文件的字符编码
 */
export async function detectSubtitleFileEncoding(
  filePath: string,
): Promise<EncodingDetectResult> {
  const buffer = await fs.promises.readFile(filePath);
  return detectBufferEncoding(buffer);
}

/**
 * 读取并预览字幕前 N 条
 */
export async function previewSubtitleFile(
  filePath: string,
  forcedEncoding?: string,
  limit: number = 5,
): Promise<{ cues: SubtitleCue[]; format: string; encoding: string }> {
  const buffer = await fs.promises.readFile(filePath);
  const { text, detectedEncoding } = decodeBufferToString(buffer, forcedEncoding);
  const format = detectSubtitleFormatFromContent(filePath, text);
  const cues = parseSubtitleCues(text, format);
  return {
    cues: cues.slice(0, limit),
    format,
    encoding: detectedEncoding,
  };
}

/**
 * 转换单个字幕文件
 */
export async function convertSubtitleFile(
  config: SubtitleConvertItemConfig,
): Promise<SubtitleConvertItemResult> {
  try {
    const {
      filePath,
      targetFormat,
      sourceEncoding = 'auto',
      targetEncoding = 'utf-8',
      chineseConversion = 'none',
      cleanFormatting = false,
      includeTimestampsInTxt = true,
      outputDir,
    } = config;

    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        sourcePath: filePath,
        error: `Source file not found: ${filePath}`,
      };
    }

    const buffer = await fs.promises.readFile(filePath);
    const { text, detectedEncoding } = decodeBufferToString(
      buffer,
      sourceEncoding,
    );
    const sourceFormat = detectSubtitleFormatFromContent(filePath, text);
    let cues = parseSubtitleCues(text, sourceFormat);

    if (cues.length === 0 && sourceFormat !== 'txt') {
      return {
        success: false,
        sourcePath: filePath,
        detectedEncoding,
        error: 'No valid subtitle cues parsed from file',
      };
    }

    // 1. 样式清洗
    if (cleanFormatting) {
      cues = cues.map((cue) => ({
        ...cue,
        text: cleanSubtitleFormatting(cue.text),
      }));
    }

    // 2. 简繁转换
    const ccConverter = getOpenCCConverter(chineseConversion);
    if (ccConverter) {
      cues = cues.map((cue) => ({
        ...cue,
        text: ccConverter(cue.text),
      }));
    }

    // 3. 序列化为目标格式
    let outputContent = '';
    if (targetFormat === 'txt') {
      if (includeTimestampsInTxt) {
        outputContent = cues
          .map(
            (c, i) =>
              `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(
                c.endMs,
              )}\n${c.text}\n`,
          )
          .join('\n');
      } else {
        outputContent = cues.map((c) => c.text).join('\n\n');
      }
    } else {
      outputContent = serializeSubtitleCues(cues, targetFormat as SubtitleFormat);
    }

    // 4. 计算输出路径
    const dir = outputDir && fs.existsSync(outputDir)
      ? outputDir
      : path.dirname(filePath);
    const originalExt = path.extname(filePath);
    const baseName = path.basename(filePath, originalExt);

    let newFileName = `${baseName}.${targetFormat}`;
    let targetFilePath = path.join(dir, newFileName);

    // 如果输出路径和源路径完全一致（同格式覆盖），添加 _converted 后缀避免破坏源文件
    if (path.resolve(targetFilePath) === path.resolve(filePath)) {
      newFileName = `${baseName}_converted.${targetFormat}`;
      targetFilePath = path.join(dir, newFileName);
    }

    // 5. 编码并原子写入
    const outputBuffer = encodeStringToBuffer(outputContent, targetEncoding);
    const tempFilePath = path.join(
      dir,
      `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.${targetFormat}`,
    );

    await fs.promises.writeFile(tempFilePath, outputBuffer);
    try {
      await fs.promises.rename(tempFilePath, targetFilePath);
    } catch {
      // 跨设备移动失败降级
      await fs.promises.copyFile(tempFilePath, targetFilePath);
      await fs.promises.unlink(tempFilePath).catch(() => {});
    }

    return {
      success: true,
      sourcePath: filePath,
      outputPath: targetFilePath,
      format: targetFormat,
      count: cues.length,
      detectedEncoding,
    };
  } catch (err: any) {
    return {
      success: false,
      sourcePath: config.filePath,
      error: err.message || String(err),
    };
  }
}

/**
 * 批量转换字幕文件
 */
export async function batchConvertSubtitles(
  configs: SubtitleConvertItemConfig[],
): Promise<SubtitleConvertItemResult[]> {
  const results: SubtitleConvertItemResult[] = [];
  for (const cfg of configs) {
    const res = await convertSubtitleFile(cfg);
    results.push(res);
  }
  return results;
}

/**
 * 容器内封软字幕扫描与提取服务
 *
 * 快速扫描 MKV/MP4/WebM/MOV 容器中的内封软字幕轨，
 * 并支持选择单轨或多轨一键秒级提取为外部 SRT/ASS/VTT 文件。
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { logMessage } from '../logger';
import { TEXT_SUBTITLE_CODECS } from '../embeddedSubtitleParser';
import type {
  EmbeddedSubtitleStreamInfo,
  ExtractEmbeddedSubtitleConfig,
  ExtractEmbeddedSubtitleResult,
} from '../../../types/toolbox';

const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');

/**
 * 探测视频中的所有内封字幕轨
 */
export function scanEmbeddedSubtitles(
  videoPath: string,
): Promise<EmbeddedSubtitleStreamInfo[]> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(videoPath)) {
      return reject(new Error(`Video file not found: ${videoPath}`));
    }

    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', videoPath]);
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      const streams: EmbeddedSubtitleStreamInfo[] = [];
      const lines = stderr.split(/\r?\n/);
      let subIndex = 0;

      const subRegex =
        /Stream #\d+:(\d+)(?:\[0x[0-9a-fA-F]+\])?(?:\(([^)]*)\))?:\s*Subtitle:\s*([A-Za-z0-9_]+)/i;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(subRegex);
        if (!match) continue;

        const language =
          match[2] && match[2].toLowerCase() !== 'und'
            ? match[2].trim()
            : undefined;
        const codec = match[3].toLowerCase();

        const isDefault = /\(default\)/i.test(line);
        const isForced = /\(forced\)/i.test(line);
        const isText = TEXT_SUBTITLE_CODECS.has(codec);

        // 尝试在后续几行探测 Title 元数据
        let title: string | undefined;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const nextLine = lines[j];
          if (/Stream #\d+:/i.test(nextLine)) break;
          const titleMatch = /^\s*title\s*:\s*(.+)$/i.exec(nextLine);
          if (titleMatch) {
            title = titleMatch[1].trim();
            break;
          }
        }

        streams.push({
          subIndex,
          codec,
          language,
          title,
          isDefault,
          isForced,
          isText,
        });

        subIndex++;
      }

      resolve(streams);
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 提取指定的内封字幕轨
 */
export async function extractEmbeddedSubtitles(
  config: ExtractEmbeddedSubtitleConfig,
): Promise<ExtractEmbeddedSubtitleResult> {
  const { videoPath, streamIndices, targetFormat = 'srt', outputDir } = config;

  if (!fs.existsSync(videoPath)) {
    return {
      success: false,
      extractedFiles: [],
      error: `Video file not found: ${videoPath}`,
    };
  }

  const dir = outputDir && fs.existsSync(outputDir)
    ? outputDir
    : path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const baseName = path.basename(videoPath, ext);

  const streams = await scanEmbeddedSubtitles(videoPath);
  const extractedFiles: Array<{
    subIndex: number;
    outputPath: string;
    language?: string;
  }> = [];
  const errors: string[] = [];

  for (const idx of streamIndices) {
    const stream = streams.find((s) => s.subIndex === idx);
    if (!stream) {
      errors.push(`未找到轨道 #${idx + 1}`);
      continue;
    }

    if (!stream.isText) {
      errors.push(`轨道 #${idx + 1} (${stream.codec}) 为位图字幕，不支持提取为纯文本`);
      continue;
    }

    const langTag = stream.language ? `_${stream.language}` : `_track${idx + 1}`;
    const outName = `${baseName}${langTag}.${targetFormat}`;
    const outPath = path.join(dir, outName);

    const codecArg = targetFormat === 'srt'
      ? 'subrip'
      : targetFormat === 'ass'
        ? 'ass'
        : 'webvtt';

    const args = [
      '-hide_banner',
      '-y',
      '-i',
      videoPath,
      '-map',
      `0:s:${idx}`,
      '-c:s',
      codecArg,
      outPath,
    ];

    logMessage(`执行提取内封字幕: ${ffmpegPath} ${args.join(' ')}`, 'info');

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, args);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outPath)) {
          extractedFiles.push({
            subIndex: idx,
            outputPath: outPath,
            language: stream.language,
          });
          resolve();
        } else {
          const failMsg = `提取字幕轨 #${idx + 1} 失败 (exit code ${code}): ${stderr.slice(-150)}`;
          logMessage(failMsg, 'warning');
          errors.push(failMsg);
          resolve(); // 单轨失败不阻塞其它轨道
        }
      });
      proc.on('error', reject);
    });
  }

  return {
    success: extractedFiles.length > 0,
    extractedFiles,
    error:
      extractedFiles.length === 0
        ? errors.join('; ') || 'No subtitles extracted'
        : undefined,
  };
}

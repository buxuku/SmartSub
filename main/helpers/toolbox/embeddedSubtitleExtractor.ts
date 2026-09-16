/**
 * 容器内封软字幕扫描与提取服务
 *
 * 快速扫描 MKV/MP4/WebM/MOV 容器中的内封软字幕轨，
 * 并支持选择单轨或多轨一键秒级提取为外部 SRT/ASS/VTT 文件。
 */

import fs from 'fs';
import { reserveToolboxOutput, toolboxOutputDirectory } from './outputPath';
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
const activeExtractions = new Map<string, AbortController>();

export function cancelEmbeddedSubtitleExtraction(jobId: string): boolean {
  const controller = activeExtractions.get(jobId);
  controller?.abort();
  return Boolean(controller);
}

export function cancelAllEmbeddedSubtitleExtractions(): void {
  for (const controller of activeExtractions.values()) controller.abort();
}

/**
 * 探测视频中的所有内封字幕轨
 */
export function scanEmbeddedSubtitles(
  videoPath: string,
  signal?: AbortSignal,
): Promise<EmbeddedSubtitleStreamInfo[]> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(videoPath)) {
      return reject(new Error(`Video file not found: ${videoPath}`));
    }

    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', videoPath], {
      signal,
    });
    let stderr = '';
    let processError: Error | undefined;

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      if (processError) return reject(processError);
      if (signal?.aborted)
        return reject(new Error('Subtitle extraction cancelled'));
      if (!/Input #\d+/i.test(stderr))
        return reject(
          new Error(`Unable to scan subtitles: ${stderr.slice(-300)}`),
        );
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
      processError = err;
    });
  });
}

/**
 * 提取指定的内封字幕轨
 */
export async function extractEmbeddedSubtitles(
  config: ExtractEmbeddedSubtitleConfig,
  jobId?: string,
  onProgress?: (percent: number) => void,
): Promise<ExtractEmbeddedSubtitleResult> {
  const { videoPath, streamIndices, targetFormat = 'srt', outputDir } = config;
  const extractedFiles: ExtractEmbeddedSubtitleResult['extractedFiles'] = [];
  const errors: string[] = [];
  if (jobId && activeExtractions.has(jobId))
    return {
      success: false,
      extractedFiles,
      error: 'Subtitle extraction already running',
    };
  const controller = new AbortController();
  if (jobId) activeExtractions.set(jobId, controller);
  try {
    if (!['srt', 'ass', 'vtt'].includes(targetFormat))
      throw new Error('Invalid subtitle format');
    if (
      !Array.isArray(streamIndices) ||
      !streamIndices.length ||
      streamIndices.some((index) => !Number.isSafeInteger(index) || index < 0)
    )
      throw new Error('Select valid subtitle tracks');
    const dir = toolboxOutputDirectory(outputDir, videoPath);
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const streams = await scanEmbeddedSubtitles(videoPath, controller.signal);
    const indices = [...new Set(streamIndices)];
    for (const [position, idx] of indices.entries()) {
      if (controller.signal.aborted)
        throw new Error('Subtitle extraction cancelled');
      const stream = streams.find((s) => s.subIndex === idx);
      if (!stream) {
        errors.push(`未找到轨道 #${idx + 1}`);
        continue;
      }

      if (!stream.isText) {
        errors.push(
          `轨道 #${idx + 1} (${stream.codec}) 为位图字幕，不支持提取为纯文本`,
        );
        continue;
      }

      const langTag = stream.language
        ? `_${stream.language.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        : `_track${idx + 1}`;
      const outName = `${baseName}${langTag}.${targetFormat}`;
      let outPath: string | undefined;
      try {
        outPath = reserveToolboxOutput(path.join(dir, outName));

        const codecArg =
          targetFormat === 'srt'
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
          const proc = spawn(ffmpegPath, args, { signal: controller.signal });
          let stderr = '';
          // Keep diagnostics bounded even for long or malformed media.
          proc.stderr.on(
            'data',
            (d) => (stderr = (stderr + d.toString()).slice(-1000)),
          );
          let processError: Error | undefined;
          proc.on('close', (code) => {
            if (code === 0 && !controller.signal.aborted) {
              resolve();
            } else {
              reject(
                processError ||
                  new Error(
                    `提取字幕轨 #${idx + 1} 失败 (exit code ${code}): ${stderr.slice(-150)}`,
                  ),
              );
            }
          });
          proc.on('error', (error) => {
            // Wait for close before unlocking or removing the output.
            processError = error;
          });
        });
        if (fs.statSync(outPath).size === 0)
          throw new Error('Extracted subtitle is empty');
        extractedFiles.push({
          subIndex: idx,
          outputPath: outPath,
          language: stream.language,
        });
      } catch (error) {
        if (outPath) {
          try {
            fs.unlinkSync(outPath);
          } catch {}
        }
        errors.push(
          `Track #${idx + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      onProgress?.(((position + 1) / indices.length) * 100);
    }
    if (controller.signal.aborted) errors.push('Subtitle extraction cancelled');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (jobId) activeExtractions.delete(jobId);
  }

  return {
    success: extractedFiles.length > 0 && errors.length === 0,
    extractedFiles,
    error: errors.length
      ? errors.join('; ')
      : extractedFiles.length
        ? undefined
        : 'No subtitles extracted',
  };
}

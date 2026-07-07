import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { logMessage } from './storeManager';
import { getMd5, ensureTempDir, timemarkToSeconds } from './fileUtils';
import { getTaskContext, TaskCancelledError } from './taskContext';
import { energySpeechSegments } from './subtitleTiming';
import { computeChunkBoundaries } from './cloudAudioChunking';
import { spawn } from 'child_process';
import {
  parseSubtitleStreams,
  EmbeddedSubtitleStream,
} from './embeddedSubtitleParser';
import { stderrTail, toFriendlyFfmpegError } from './ffmpegErrorUtils';

// 设置ffmpeg路径
const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(ffmpegPath);

/** 正在运行的提取进程：fileUuid -> fluent-ffmpeg command（取消时 kill） */
const runningCommands = new Map<string, ReturnType<typeof ffmpeg>>();

/** 取消时终止指定文件的 ffmpeg 提取进程 */
export function killFfmpegForFiles(fileUuids: string[]) {
  for (const uuid of fileUuids) {
    const command = runningCommands.get(uuid);
    if (!command) continue;
    try {
      command.kill('SIGKILL');
      logMessage(
        `ffmpeg extraction killed for cancelled file ${uuid}`,
        'warning',
      );
    } catch (error) {
      logMessage(`ffmpeg kill failed: ${error}`, 'warning');
    }
    runningCommands.delete(uuid);
  }
}

/**
 * 使用ffmpeg提取音频
 */
export const extractAudio = (
  videoPath,
  audioPath,
  event = null,
  file = null,
) => {
  const onProgress = (percent = 0) => {
    const safePercent = Math.min(Math.max(Math.round(percent), 0), 100);
    logMessage(`extract audio progress ${safePercent}%`, 'info');
    if (event && file) {
      event.sender.send(
        'taskProgressChange',
        file,
        'extractAudio',
        safePercent,
      );
    }
  };
  // 同步捕获上下文：回调里不依赖 ALS 跨 emitter 传播
  const taskContext = getTaskContext();
  const fileUuid = file?.uuid || taskContext?.fileUuid;
  const signal = taskContext?.signal;

  const unregister = () => {
    if (fileUuid) runningCommands.delete(fileUuid);
  };

  return new Promise((resolve, reject) => {
    // fluent-ffmpeg 的 progress.percent 在部分平台/新版 ffmpeg 上恒为 undefined，
    // 这里从 codecData 拿到媒体总时长，再用 progress.timemark 自算百分比（issue #291）。
    let totalDurationSec = 0;
    try {
      const command = ffmpeg(`${videoPath}`)
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .outputOptions('-y')
        .on('start', function (str) {
          onProgress(0);
          logMessage(`extract audio start ${str}`, 'info');
        })
        .on('codecData', function (data) {
          totalDurationSec = timemarkToSeconds(data?.duration);
          // 顺手记录媒体时长，随后续 taskFileChange 持久化供行内元信息展示
          if (file && totalDurationSec > 0) {
            file.duration = totalDurationSec;
          }
        })
        .on('progress', function (progress) {
          let percent = progress.percent;
          if (
            (percent === undefined ||
              percent === null ||
              Number.isNaN(percent) ||
              percent <= 0) &&
            totalDurationSec > 0 &&
            progress.timemark
          ) {
            percent =
              (timemarkToSeconds(progress.timemark) / totalDurationSec) * 100;
          }
          onProgress(percent || 0);
        })
        .on('end', function (str) {
          unregister();
          logMessage(`extract audio done!`, 'info');
          onProgress(100);
          resolve(true);
        })
        .on('error', function (err, _stdout, stderr) {
          unregister();
          if (signal?.aborted) {
            // 用户取消导致的 kill：清理半成品，按取消路径返回
            try {
              if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
            } catch (cleanupErr) {
              logMessage(
                `cleanup partial audio failed: ${cleanupErr}`,
                'warning',
              );
            }
            logMessage(`extract audio cancelled`, 'warning');
            reject(new TaskCancelledError());
            return;
          }
          const tail = stderrTail(stderr);
          logMessage(
            `extract audio error: ${err}${tail ? `\nffmpeg stderr:\n${tail}` : ''}`,
            'error',
          );
          reject(toFriendlyFfmpegError(err, stderr));
        });
      if (fileUuid) runningCommands.set(fileUuid, command);
      command.save(`${audioPath}`);
    } catch (err) {
      unregister();
      logMessage(`ffmpeg extract audio error: ${err}`, 'error');
      reject(`${err}: ffmpeg extract audio error!`);
    }
  });
};

/**
 * 从视频中提取音频
 */
export async function extractAudioFromVideo(event, file) {
  const { filePath } = file;
  event.sender.send('taskFileChange', { ...file, extractAudio: 'loading' });
  const tempDir = ensureTempDir();

  logMessage(`tempDir: ${tempDir}`, 'info');
  const md5FileName = getMd5(filePath);
  const tempAudioFile = path.join(tempDir, `${md5FileName}.wav`);
  file.tempAudioFile = tempAudioFile;

  if (fs.existsSync(tempAudioFile)) {
    logMessage(`Using existing audio file: ${tempAudioFile}`, 'info');
    event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });
    return tempAudioFile;
  }

  await extractAudio(filePath, tempAudioFile, event, file);
  event.sender.send('taskFileChange', { ...file, extractAudio: 'done' });
  return tempAudioFile;
}

/**
 * 探测视频内封字幕流：spawn 内置 ffmpeg `-i` 解析 stderr，永不 reject。
 * ffmpeg 因无输出文件以非零码退出属正常，照常解析 stderr。带超时保护。
 */
export function probeEmbeddedSubtitles(
  videoPath: string,
  timeoutMs = 15000,
): Promise<EmbeddedSubtitleStream[]> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout;
    const done = (result: EmbeddedSubtitleStream[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-i', videoPath]);
    } catch (err) {
      logMessage(`probe embedded subtitle spawn failed: ${err}`, 'warning');
      resolve([]);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      logMessage(`probe embedded subtitle timeout: ${videoPath}`, 'warning');
      done([]);
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      logMessage(`probe embedded subtitle error: ${err}`, 'warning');
      done([]);
    });
    child.on('close', () => {
      try {
        done(parseSubtitleStreams(stderr));
      } catch (err) {
        logMessage(`parse subtitle streams failed: ${err}`, 'warning');
        done([]);
      }
    });
  });
}

/**
 * 抽取指定内封字幕轨为 SRT（-map 0:s:N -c:s srt）。复用 runningCommands 支持取消；
 * 进度归属「提取」节点（extractAudio）。失败/取消时清理半成品。
 */
export const extractEmbeddedSubtitle = (
  videoPath: string,
  subIndex: number,
  outPath: string,
  event = null,
  file = null,
): Promise<void> => {
  const onProgress = (percent = 0) => {
    const safePercent = Math.min(Math.max(Math.round(percent), 0), 100);
    if (event && file) {
      event.sender.send(
        'taskProgressChange',
        file,
        'extractAudio',
        safePercent,
      );
    }
  };
  const taskContext = getTaskContext();
  const fileUuid = file?.uuid || taskContext?.fileUuid;
  const signal = taskContext?.signal;
  const unregister = () => {
    if (fileUuid) runningCommands.delete(fileUuid);
  };
  const cleanupPartial = () => {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (err) {
      logMessage(`cleanup partial subtitle failed: ${err}`, 'warning');
    }
  };

  return new Promise((resolve, reject) => {
    try {
      const command = ffmpeg(`${videoPath}`)
        .outputOptions(['-map', `0:s:${subIndex}`, '-c:s', 'srt', '-y'])
        .on('start', function (str) {
          onProgress(0);
          logMessage(`extract embedded subtitle start ${str}`, 'info');
        })
        .on('progress', function (progress) {
          onProgress(progress?.percent || 0);
        })
        .on('end', function () {
          unregister();
          onProgress(100);
          logMessage(`extract embedded subtitle done!`, 'info');
          resolve();
        })
        .on('error', function (err, _stdout, stderr) {
          unregister();
          cleanupPartial();
          if (signal?.aborted) {
            logMessage(`extract embedded subtitle cancelled`, 'warning');
            reject(new TaskCancelledError());
            return;
          }
          const tail = stderrTail(stderr);
          logMessage(
            `extract embedded subtitle error: ${err}${tail ? `\nffmpeg stderr:\n${tail}` : ''}`,
            'error',
          );
          reject(err);
        });
      if (fileUuid) runningCommands.set(fileUuid, command);
      command.save(`${outPath}`);
    } catch (err) {
      unregister();
      cleanupPartial();
      logMessage(`ffmpeg extract embedded subtitle error: ${err}`, 'error');
      reject(err);
    }
  });
};

// ===========================================================================
// 云端听写（在线 ASR）音频准备：压缩以适配大小限制 + 静音切片以适配时长/大小限制。
// 本地转写路径不受影响——始终保留原始 16kHz 单声道 WAV（能量分析/裁尾依赖它）。
// ===========================================================================

/** 云上传大小安全上限（多数 OpenAI 兼容端点为 25MB，留余量取 24MB）。 */
export const CLOUD_MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
/** 单切片最长时长（秒）：600s 的 16kHz 单声道 PCM WAV ≈ 18MB，稳落上限内。 */
export const CLOUD_MAX_CHUNK_SECONDS = 600;

export interface PreparedCloudAudio {
  /** 可直接上传的音频路径（原 WAV 或压缩后的 mp3）。 */
  path: string;
  /** 是否为压缩产物（true 时 cleanup 会删除临时文件）。 */
  compressed: boolean;
  /** 文件大小（字节）。 */
  sizeBytes: number;
  /** 清理临时产物（原始 WAV 传入时为 no-op）。 */
  cleanup: () => void;
}

export interface CloudAudioChunk {
  path: string;
  /** 该切片在原始音频中的起点偏移（秒），用于回拼时间轴。 */
  startOffsetSec: number;
  /** 该切片在原始音频中的终点（秒），用于无时间戳降级时生成 cue 时间跨度。 */
  endOffsetSec: number;
}

function fileSizeBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 运行一个 fluent-ffmpeg 命令并落盘；支持通过 AbortSignal 取消（kill 进程 + 清理半成品）。 */
function runFfmpegSave(
  command: ReturnType<typeof ffmpeg>,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanupPartial = () => {
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch {
        /* ignore */
      }
    };
    const onAbort = () => {
      try {
        command.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    if (signal?.aborted) {
      cleanupPartial();
      reject(new TaskCancelledError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    command
      .on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      })
      .on('error', (err, _stdout, stderr) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          cleanupPartial();
          reject(new TaskCancelledError());
          return;
        }
        const tail = stderrTail(stderr);
        if (tail) {
          logMessage(`ffmpeg save error stderr:\n${tail}`, 'error');
        }
        reject(err);
      })
      .save(outPath);
  });
}

/** Float32 PCM → 16-bit PCM WAV（单声道）。 */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/** 将 Float32 PCM 写入 16-bit 单声道 WAV 文件。 */
export function writePcm16Wav(
  samples: Float32Array,
  sampleRate: number,
  outPath: string,
): void {
  fs.writeFileSync(outPath, encodeWav(samples, sampleRate));
}

/** 读取 16-bit PCM WAV，返回 Float32 样本与采样率。 */
export function readPcm16Wav(filePath: string): {
  samples: Float32Array;
  sampleRate: number;
} {
  const buf = fs.readFileSync(filePath);
  let sampleRate = 44100;
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      sampleRate = buf.readUInt32LE(off + 8 + 4);
    }
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      }
      return { samples: out, sampleRate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('wav: data chunk not found');
}

/**
 * ffmpeg atempo 变速（wav→wav）。factor ≥1 为加速压缩时长。
 * 配音对齐硬上限 ≤1.5，单段 atempo 滤镜即可。
 */
export async function ffmpegAtempo(
  inWav: string,
  outWav: string,
  factor: number,
  signal?: AbortSignal,
): Promise<void> {
  const command = ffmpeg(inWav)
    .audioFilters(`atempo=${factor.toFixed(4)}`)
    .audioCodec('pcm_s16le')
    .outputOptions('-y');
  await runFfmpegSave(command, outWav, signal);
}

/** 重采样到目标采样率（默认 48kHz，用于 mp3/软封装导出）。 */
export async function resampleAudio(
  inPath: string,
  outPath: string,
  sampleRate = 48_000,
  signal?: AbortSignal,
): Promise<void> {
  const command = ffmpeg(inPath)
    .audioFrequency(sampleRate)
    .audioCodec('pcm_s16le')
    .outputOptions('-y');
  await runFfmpegSave(command, outPath, signal);
}

/** 将音频编码为 48kHz mp3（配音导出可选形态）。 */
export async function encodeAudioMp3(
  inPath: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const command = ffmpeg(inPath)
    .audioFrequency(48_000)
    .audioCodec('libmp3lame')
    .audioBitrate('192k')
    .outputOptions('-y');
  await runFfmpegSave(command, outPath, signal);
}

const SOFT_MUX_EXTENSIONS = new Set(['.mp4', '.mkv']);

/** 容器是否支持软封装附加音轨（mp4/mkv）。 */
export function canSoftMuxContainer(fileExtension: string): boolean {
  return SOFT_MUX_EXTENSIONS.has((fileExtension || '').toLowerCase());
}

/**
 * 软封装：保留原视频流与原音轨，附加配音为第二条音轨（配音轨转 AAC）。
 */
export async function muxSoftAudioTrack(
  videoPath: string,
  audioPath: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const command = ffmpeg(videoPath)
    .input(audioPath)
    .outputOptions([
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a:0',
      'copy',
      '-c:a:1',
      'aac',
      '-b:a:1',
      '192k',
      '-y',
    ]);
  await runFfmpegSave(command, outPath, signal);
}

/**
 * 压缩音频到 mp3（单声道 16kHz、低码率）以显著缩小上传体积。转写时间戳来自模型而非容器格式，
 * mp3 不影响词级/段级时间戳质量。返回压缩后临时文件路径。
 */
async function compressToMp3(
  srcWav: string,
  signal?: AbortSignal,
): Promise<string> {
  const outPath = path.join(ensureTempDir(), `cloud-asr-${uuidv4()}.mp3`);
  logMessage(`cloud ASR: compressing audio -> ${outPath}`, 'info');
  const command = ffmpeg(srcWav)
    .audioFrequency(16000)
    .audioChannels(1)
    .audioCodec('libmp3lame')
    .audioBitrate('32k')
    .outputOptions('-y');
  await runFfmpegSave(command, outPath, signal);
  return outPath;
}

/**
 * 为云上传准备音频：
 * - 原始 WAV 已 ≤ 上限 → 原样返回（保真、保词级时间戳，cleanup 为 no-op）；
 * - 超限 → 压缩为 mp3 再返回（仍可能超限，超长音频由调用方改走切片）。
 */
export async function prepareCloudAudio(
  audioPath: string,
  opts?: { maxBytes?: number; signal?: AbortSignal },
): Promise<PreparedCloudAudio> {
  const maxBytes = opts?.maxBytes ?? CLOUD_MAX_UPLOAD_BYTES;
  const originalSize = fileSizeBytes(audioPath);
  if (originalSize > 0 && originalSize <= maxBytes) {
    return {
      path: audioPath,
      compressed: false,
      sizeBytes: originalSize,
      cleanup: () => {},
    };
  }

  const compressedPath = await compressToMp3(audioPath, opts?.signal);
  const compressedSize = fileSizeBytes(compressedPath);
  return {
    path: compressedPath,
    compressed: true,
    sizeBytes: compressedSize,
    cleanup: () => {
      try {
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
      } catch (err) {
        logMessage(
          `cloud ASR: cleanup compressed audio failed: ${err}`,
          'warning',
        );
      }
    },
  };
}

/**
 * 按静音把音频切成 ≤ maxChunkSeconds 的多个 WAV 切片（复用能量法找静音边界）。
 * 每个切片仍为 16kHz 单声道 PCM WAV，随起点偏移一并返回，供回拼时间轴。
 * 无法分析（能量为空）→ 返回整段单切片（降级，不阻断）。
 */
export async function splitBySilence(
  audioPath: string,
  opts?: { maxChunkSeconds?: number; signal?: AbortSignal },
): Promise<CloudAudioChunk[]> {
  const maxChunkSeconds = opts?.maxChunkSeconds ?? CLOUD_MAX_CHUNK_SECONDS;
  const segments = energySpeechSegments(audioPath);
  const totalDurationSec = segments.length
    ? segments[segments.length - 1].end
    : 0;
  const boundaries = computeChunkBoundaries(
    segments,
    totalDurationSec,
    maxChunkSeconds,
  );

  if (boundaries.length <= 1) {
    return [
      { path: audioPath, startOffsetSec: 0, endOffsetSec: totalDurationSec },
    ];
  }

  const tempDir = ensureTempDir();
  const chunks: CloudAudioChunk[] = [];
  try {
    for (const b of boundaries) {
      if (opts?.signal?.aborted) throw new TaskCancelledError();
      const outPath = path.join(tempDir, `cloud-asr-chunk-${uuidv4()}.wav`);
      const command = ffmpeg(audioPath)
        .setStartTime(b.start)
        .setDuration(Math.max(0.1, b.end - b.start))
        .audioFrequency(16000)
        .audioChannels(1)
        .audioCodec('pcm_s16le')
        .outputOptions('-y');
      await runFfmpegSave(command, outPath, opts?.signal);
      chunks.push({
        path: outPath,
        startOffsetSec: b.start,
        endOffsetSec: b.end,
      });
    }
  } catch (error) {
    // 失败/取消：清理已产出的切片，避免残留。
    for (const c of chunks) {
      try {
        if (fs.existsSync(c.path)) fs.unlinkSync(c.path);
      } catch {
        /* ignore */
      }
    }
    throw error;
  }
  return chunks;
}

/** 清理切片临时文件（跳过原始音频路径本身）。 */
export function cleanupCloudChunks(
  chunks: CloudAudioChunk[],
  keepPath?: string,
): void {
  for (const c of chunks) {
    if (keepPath && c.path === keepPath) continue;
    try {
      if (fs.existsSync(c.path)) fs.unlinkSync(c.path);
    } catch (err) {
      logMessage(`cloud ASR: cleanup chunk failed: ${err}`, 'warning');
    }
  }
}

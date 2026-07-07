import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { TaskCancelledError } from '../taskContext';
import { stderrTail } from '../ffmpegErrorUtils';

// 与 audioProcessor 同源的 ffmpeg 路径设置（本模块可被独立引入）。
const FFMPEG_BIN = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
ffmpeg.setFfmpegPath(FFMPEG_BIN);

/**
 * 探测媒体总时长（ms）：spawn `ffmpeg -i` 解析 stderr 的 `Duration: HH:MM:SS.cc`。
 * 不依赖 ffprobe（应用未捆绑）。解析失败返回 0（调用方回落字幕末条推算）。
 */
export function probeMediaDurationMs(
  mediaPath: string,
  timeoutMs = 15000,
): Promise<number> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout;
    const done = (ms: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ms);
    };
    let child;
    try {
      child = spawn(FFMPEG_BIN, ['-hide_banner', '-i', mediaPath]);
    } catch {
      resolve(0);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(0);
    }, timeoutMs);
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', () => done(0));
    child.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (!m) return done(0);
      const [, h, min, s, cs] = m;
      done(
        ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 +
          Number(cs.padEnd(3, '0').slice(0, 3)),
      );
    });
  });
}

// ===========================================================================
// 配音音频管线：WAV 头时长测量 / atempo 链式变速 / 槽位拼接 / ducking 混流 /
// 音轨替换与新增。应用未捆绑 ffprobe——一切测量走 WAV 头解析。
// 取消模式：全部落盘操作走 runSave（AbortSignal kill + 半成品清理，形制
// audioProcessor.runFfmpegSave）。本模块保持零 electron 依赖（无 storeManager），
// PoC 脚本与 test:dubbing 可在纯 node 下直接引入。
// ===========================================================================

/** 同 audioProcessor.runFfmpegSave，但 stderr 尾部并入 reject 错误信息（无 logMessage 依赖）。 */
function runSave(
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
        cleanupPartial();
        const tail = stderrTail(stderr);
        reject(
          new Error(
            `${err?.message ?? err}${tail ? `\nffmpeg stderr:\n${tail}` : ''}`,
          ),
        );
      })
      .save(outPath);
  });
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** data chunk 起始偏移（字节）。 */
  dataOffset: number;
  /** data chunk 字节数。 */
  dataBytes: number;
  durationMs: number;
}

/**
 * 解析 WAV（RIFF）头：按 chunk 遍历定位 fmt/data，兼容 LIST 等前置 chunk。
 * 只支持 PCM（format=1）与 IEEE float（format=3）——管线合同统一 16-bit PCM，
 * float 仅为容错读取（时长测量仍准确）。
 */
export function readWavInfo(file: string): WavInfo {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) !== 12) {
      throw new Error(`not a wav file (too short): ${file}`);
    }
    if (
      head.toString('ascii', 0, 4) !== 'RIFF' ||
      head.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new Error(`not a RIFF/WAVE file: ${file}`);
    }
    const fileSize = fs.fstatSync(fd).size;
    let offset = 12;
    let fmt: {
      sampleRate: number;
      channels: number;
      bitsPerSample: number;
    } | null = null;
    let dataOffset = -1;
    let dataBytes = -1;
    const chunkHead = Buffer.alloc(8);
    while (offset + 8 <= fileSize) {
      fs.readSync(fd, chunkHead, 0, 8, offset);
      const id = chunkHead.toString('ascii', 0, 4);
      const size = chunkHead.readUInt32LE(4);
      if (id === 'fmt ') {
        const body = Buffer.alloc(Math.min(size, 16));
        fs.readSync(fd, body, 0, body.length, offset + 8);
        const format = body.readUInt16LE(0);
        if (format !== 1 && format !== 3) {
          throw new Error(`unsupported wav format ${format}: ${file}`);
        }
        fmt = {
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          bitsPerSample: body.readUInt16LE(14),
        };
      } else if (id === 'data') {
        dataOffset = offset + 8;
        // 流式写出的 wav 可能声明 0xFFFFFFFF 或 0：按实际文件大小校正。
        dataBytes =
          size === 0 || offset + 8 + size > fileSize
            ? fileSize - offset - 8
            : size;
      }
      // chunk 按 2 字节对齐。
      offset += 8 + size + (size % 2);
      if (fmt && dataOffset >= 0) break;
    }
    if (!fmt || dataOffset < 0) {
      throw new Error(`wav missing fmt/data chunk: ${file}`);
    }
    const bytesPerSecond =
      fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
    return {
      ...fmt,
      dataOffset,
      dataBytes,
      durationMs:
        bytesPerSecond > 0
          ? Math.round((dataBytes / bytesPerSecond) * 1000)
          : 0,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** 实测 wav 时长（ms）——对齐引擎复测决策的输入。 */
export function wavDurationMs(file: string): number {
  return readWavInfo(file).durationMs;
}

/**
 * atempo 链分解：单级 atempo 限 [0.5, 2.0]，超出自动串联
 * （3.0 → [2.0, 1.5]；0.4 → [0.5, 0.8]）。纯函数，供单测。
 */
export function buildAtempoChain(factor: number): number[] {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`invalid atempo factor: ${factor}`);
  }
  const chain: number[] = [];
  let f = factor;
  while (f > 2.0) {
    chain.push(2.0);
    f /= 2.0;
  }
  while (f < 0.5) {
    chain.push(0.5);
    f /= 0.5;
  }
  // 剩余因子接近 1 时省略（避免无谓的重采样级）。
  if (Math.abs(f - 1) > 1e-3 || chain.length === 0) chain.push(f);
  return chain.map((v) => Math.round(v * 1000) / 1000);
}

/**
 * 任意音频（mp3/opus/wav…）→ 16-bit PCM 单声道 wav（统一 24kHz）。
 * 云端 TTS 返回格式各异（且同为 wav 采样率也不一），统一归口保证
 * assembleTrack 的同格式前提与试听一致性。
 */
export async function transcodeToPcm16Wav(
  src: string,
  dst: string,
  opts?: { sampleRate?: number; signal?: AbortSignal },
): Promise<void> {
  const command = ffmpeg(src)
    .audioFrequency(opts?.sampleRate ?? 24000)
    .audioChannels(1)
    .audioCodec('pcm_s16le')
    .outputOptions('-y');
  await runSave(command, dst, opts?.signal);
}

/** atempo 变速（不保音高的时长压缩/拉伸），输出同采样率 16-bit PCM wav。 */
export async function atempoWav(
  src: string,
  dst: string,
  factor: number,
  signal?: AbortSignal,
): Promise<void> {
  const filters = buildAtempoChain(factor).map((f) => `atempo=${f}`);
  const command = ffmpeg(src)
    .audioFilters(filters)
    .audioCodec('pcm_s16le')
    .outputOptions('-y');
  await runSave(command, dst, signal);
}

// ── 槽位拼接（PCM 级，零 ffmpeg）───────────────────────────────────────────

export interface TrackSegment {
  wavPath: string;
  /** 拼接时间轴上的起点（ms）。 */
  targetStartMs: number;
  /** 截断上限（ms）：overflow=truncate 时 = 槽位末端；缺省不截断。 */
  maxDurationMs?: number;
}

/**
 * 按槽位规划把逐条配音 wav 拼成完整音轨：间隙补静音、可选截断、尾部可补齐到
 * totalDurationMs。**PCM 级采样精确拼接**（直接写字节，不经 ffmpeg concat）：
 * 逐段 concat 的 ms 取整会累积漂移，采样级定位则每条都锚定绝对时间轴。
 * 前提：所有分段 wav 同采样率/单声道/16-bit（同一引擎产出 + 云端落盘时归一）。
 */
export async function assembleTrack(
  segments: TrackSegment[],
  outPath: string,
  opts?: { totalDurationMs?: number; signal?: AbortSignal },
): Promise<{ durationMs: number; sampleRate: number }> {
  if (segments.length === 0) throw new Error('assembleTrack: empty segments');
  const ordered = [...segments].sort(
    (a, b) => a.targetStartMs - b.targetStartMs,
  );
  const infos = ordered.map((s) => readWavInfo(s.wavPath));
  const { sampleRate, channels, bitsPerSample } = infos[0];
  if (channels !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `assembleTrack expects 16-bit mono wav, got ${bitsPerSample}-bit ${channels}ch: ${ordered[0].wavPath}`,
    );
  }
  for (let i = 1; i < infos.length; i++) {
    if (
      infos[i].sampleRate !== sampleRate ||
      infos[i].channels !== channels ||
      infos[i].bitsPerSample !== bitsPerSample
    ) {
      throw new Error(
        `assembleTrack: segment format mismatch (${infos[i].sampleRate}Hz/${infos[i].channels}ch vs ${sampleRate}Hz/${channels}ch): ${ordered[i].wavPath}`,
      );
    }
  }

  const bytesPerSample = 2;
  const msToBytes = (ms: number) =>
    // 采样数取整后换算字节，保证 16-bit 对齐。
    Math.round((ms / 1000) * sampleRate) * bytesPerSample;

  // 预算总长：显式 totalDurationMs 或最后一段的自然末端。
  let totalBytes = 0;
  const placed = ordered.map((seg, i) => {
    const startByte = msToBytes(seg.targetStartMs);
    let dataBytes = infos[i].dataBytes;
    if (seg.maxDurationMs !== undefined) {
      dataBytes = Math.min(dataBytes, msToBytes(seg.maxDurationMs));
    }
    dataBytes -= dataBytes % bytesPerSample;
    totalBytes = Math.max(totalBytes, startByte + dataBytes);
    return { startByte, dataBytes, info: infos[i], wavPath: seg.wavPath };
  });
  if (opts?.totalDurationMs !== undefined) {
    totalBytes = Math.max(totalBytes, msToBytes(opts.totalDurationMs));
  }

  const cleanupPartial = () => {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {
      /* ignore */
    }
  };

  const out = fs.createWriteStream(outPath);
  const write = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (opts?.signal?.aborted) {
        reject(new TaskCancelledError());
        return;
      }
      out.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  try {
    await write(
      buildWavHeader(totalBytes, sampleRate, channels, bitsPerSample),
    );
    const SILENCE_CHUNK = Buffer.alloc(64 * 1024);
    let cursor = 0;
    const writeSilence = async (bytes: number) => {
      let left = bytes;
      while (left > 0) {
        const n = Math.min(left, SILENCE_CHUNK.length);
        await write(
          n === SILENCE_CHUNK.length
            ? SILENCE_CHUNK
            : SILENCE_CHUNK.subarray(0, n),
        );
        left -= n;
      }
    };

    for (const p of placed) {
      // 规划保证不重叠；数值噪声导致的负间隙钳到 0（紧贴上一段末尾）。
      const gap = Math.max(0, p.startByte - cursor);
      await writeSilence(gap);
      cursor += gap;

      const fd = fs.openSync(p.wavPath, 'r');
      try {
        const buf = Buffer.alloc(256 * 1024);
        let readOffset = p.info.dataOffset;
        let left = p.dataBytes;
        while (left > 0) {
          const n = fs.readSync(
            fd,
            buf,
            0,
            Math.min(left, buf.length),
            readOffset,
          );
          if (n <= 0) break;
          await write(buf.subarray(0, n));
          readOffset += n;
          left -= n;
          cursor += n;
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    await writeSilence(Math.max(0, totalBytes - cursor));
    await new Promise<void>((resolve, reject) => {
      out.end((err: unknown) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    out.destroy();
    cleanupPartial();
    throw err;
  }

  return {
    durationMs: Math.round((totalBytes / bytesPerSample / sampleRate) * 1000),
    sampleRate,
  };
}

function buildWavHeader(
  dataBytes: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// ── 输出形态（ffmpeg 封装）─────────────────────────────────────────────────

/** wav → mp3（仅音频输出的 mp3 档；128k 对单声道语音充裕）。 */
export async function encodeMp3(
  srcWav: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const command = ffmpeg(srcWav)
    .audioCodec('libmp3lame')
    .audioBitrate('128k')
    .outputOptions('-y');
  await runSave(command, outPath, signal);
}

/**
 * 替换音轨：视频流拷贝、字幕流保留，音轨换成配音（aac）。
 * `-shortest` 不加——配音轨经 assembleTrack 补齐到媒体时长。
 */
export async function replaceAudioTrack(
  videoPath: string,
  dubWavPath: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const command = ffmpeg(videoPath)
    .input(dubWavPath)
    .outputOptions([
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '0:s?',
      '-c:v',
      'copy',
      '-c:s',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-y',
    ]);
  await runSave(command, outPath, signal);
}

/**
 * ducking 混音：原轨在配音出声时被 sidechaincompress 压低，其余时段保持原样；
 * 压低后的原轨与配音 amix 叠加（normalize=0 保持各自电平）。视频流拷贝。
 */
export async function duckMixIntoVideo(
  videoPath: string,
  dubWavPath: string,
  outPath: string,
  opts?: { signal?: AbortSignal; duckRatio?: number },
): Promise<void> {
  const ratio = opts?.duckRatio ?? 8;
  const command = ffmpeg(videoPath)
    .input(dubWavPath)
    .complexFilter([
      // 配音一分为二：一路做 sidechain 触发源，一路进最终混音。
      '[1:a]asplit=2[sc][dub]',
      `[0:a][sc]sidechaincompress=threshold=0.03:ratio=${ratio}:attack=20:release=300[bg]`,
      '[bg][dub]amix=inputs=2:duration=first:normalize=0[mix]',
    ])
    .outputOptions([
      '-map',
      '0:v',
      '-map',
      '[mix]',
      '-map',
      '0:s?',
      '-c:v',
      'copy',
      '-c:s',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-y',
    ]);
  await runSave(command, outPath, opts?.signal);
}

/** wav → aac(m4a)：addAudioTrack 的前置编码步（混流时纯流拷贝，序号无歧义）。 */
async function encodeAac(
  srcWav: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const command = ffmpeg(srcWav)
    .audioCodec('aac')
    .audioBitrate('192k')
    .outputOptions('-y');
  await runSave(command, outPath, signal);
}

/**
 * 新增音轨（多音轨 mkv）：原视频全部流拷贝 + 配音作为附加音轨。
 * 两步走：配音 wav 先编码 aac 临时文件，再全流 `-c copy` 混流——
 * 避免按输出序号指定编码器（`-c:a:N`）在原视频多音轨时错位。
 */
export async function addAudioTrack(
  videoPath: string,
  dubWavPath: string,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const aacTemp = path.join(
    path.dirname(outPath),
    `.dub-track-${Date.now()}.m4a`,
  );
  try {
    await encodeAac(dubWavPath, aacTemp, signal);
    const command = ffmpeg(videoPath)
      .input(aacTemp)
      .outputOptions(['-map', '0', '-map', '1:a', '-c', 'copy', '-y']);
    await runSave(command, outPath, signal);
  } finally {
    try {
      if (fs.existsSync(aacTemp)) fs.unlinkSync(aacTemp);
    } catch {
      /* ignore */
    }
  }
}

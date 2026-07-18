/**
 * PCM16 WAV「时间窗」能量分析（fs 定位读取，无 electron 依赖，便于 test:engines 单测）。
 *
 * 与 subtitleTiming.analyzePcm16WavEnergy 的差别：那边整读文件算全局能量/阈值；
 * 这里只读窗口字节——超长 WAV（12h≈1.4GB，18h+ 超过 Buffer/分配器上限）整读既慢又可能崩，
 * 而内置引擎分片切点只需要目标位置附近 ±45s 的能量。
 */
import fs from 'fs';

/** PCM WAV 数据布局（dubbing/audioPipeline.readWavInfo 的返回值结构兼容此接口）。 */
export interface PcmWavLayout {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** data chunk 起始偏移（字节）。 */
  dataOffset: number;
  /** data chunk 字节数。 */
  dataBytes: number;
}

const ENERGY_FRAME_MS = 20;

/**
 * 读取 [startSec, endSec) 窗口的 PCM16 采样并计算 20ms 帧 RMS 能量（dB）。
 * 非 PCM16 / 窗口越界 / 读取为空 → null（调用方退回精确切点）。
 */
export function windowFrameDb(
  audioPath: string,
  layout: PcmWavLayout,
  startSec: number,
  endSec: number,
): { frameDb: number[]; frameDurationSec: number } | null {
  if (
    layout.bitsPerSample !== 16 ||
    layout.channels <= 0 ||
    layout.sampleRate <= 0
  ) {
    return null;
  }
  const bytesPerSampleFrame = 2 * layout.channels;
  const totalFrames = Math.floor(layout.dataBytes / bytesPerSampleFrame);
  const startFrame = Math.min(
    totalFrames,
    Math.max(0, Math.floor(startSec * layout.sampleRate)),
  );
  const endFrame = Math.min(
    totalFrames,
    Math.max(startFrame, Math.ceil(endSec * layout.sampleRate)),
  );
  if (endFrame <= startFrame) return null;

  const byteLength = (endFrame - startFrame) * bytesPerSampleFrame;
  const buffer = Buffer.alloc(byteLength);
  let bytesRead = 0;
  const fd = fs.openSync(audioPath, 'r');
  try {
    bytesRead = fs.readSync(
      fd,
      buffer,
      0,
      byteLength,
      layout.dataOffset + startFrame * bytesPerSampleFrame,
    );
  } finally {
    fs.closeSync(fd);
  }
  const availFrames = Math.floor(bytesRead / bytesPerSampleFrame);
  if (availFrames <= 0) return null;

  const samplesPerEnergyFrame = Math.max(
    1,
    Math.round((layout.sampleRate * ENERGY_FRAME_MS) / 1000),
  );
  const frameDurationSec = samplesPerEnergyFrame / layout.sampleRate;
  const frameDb: number[] = [];
  for (let frame = 0; frame < availFrames; frame += samplesPerEnergyFrame) {
    const last = Math.min(availFrames, frame + samplesPerEnergyFrame);
    let sumSquares = 0;
    let count = 0;
    for (let sampleFrame = frame; sampleFrame < last; sampleFrame += 1) {
      for (let channel = 0; channel < layout.channels; channel += 1) {
        const byteOffset = (sampleFrame * layout.channels + channel) * 2;
        const sample = buffer.readInt16LE(byteOffset) / 32768;
        sumSquares += sample * sample;
        count += 1;
      }
    }
    const rms = Math.sqrt(sumSquares / Math.max(count, 1));
    frameDb.push(20 * Math.log10(Math.max(rms, 1e-8)));
  }
  return frameDb.length ? { frameDb, frameDurationSec } : null;
}

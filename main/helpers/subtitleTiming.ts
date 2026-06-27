import fs from 'fs';
import { logMessage } from './storeManager';
import { secondsToSubtitleTime, subtitleTimeToSeconds } from './fileUtils';

export type SubtitleCue = [string, string, string];

type SegmentWithOptionalWords = {
  start: number;
  end: number;
  text?: string;
  words?: Array<{ start?: number; end?: number; word?: string }>;
};

type WavInfo = {
  dataOffset: number;
  dataSize: number;
  sampleRate: number;
  channels: number;
};

export type AudioEnergy = {
  frameDurationSeconds: number;
  frameDb: number[];
  thresholdDb: number;
};

const FRAME_MS = 20;
const WORD_END_PADDING_SECONDS = 0.15;
const SILENCE_END_PADDING_SECONDS = 0.25;
const MIN_TRAILING_SILENCE_SECONDS = 0.65;
const MIN_SUBTITLE_DURATION_SECONDS = 0.25;

export function subtitleCueFromSegment(
  segment: SegmentWithOptionalWords,
): SubtitleCue {
  return [
    secondsToSubtitleTime(segment.start),
    secondsToSubtitleTime(getSpeechEndFromWords(segment) ?? segment.end),
    segment.text || '',
  ];
}

function getSpeechEndFromWords(segment: SegmentWithOptionalWords) {
  const words = segment.words || [];
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i];
    if (typeof word.word === 'string' && !word.word.trim()) continue;
    const end = Number(word.end);
    if (Number.isFinite(end) && end > segment.start && end <= segment.end + 1) {
      return Math.min(segment.end, end + WORD_END_PADDING_SECONDS);
    }
  }
  return null;
}

export function trimSubtitleTrailingSilence(
  subtitles: SubtitleCue[],
  audioFile?: string,
): SubtitleCue[] {
  if (!audioFile || !fs.existsSync(audioFile) || subtitles.length === 0) {
    return subtitles;
  }

  try {
    const energy = analyzePcm16WavEnergy(audioFile);
    if (!energy) return subtitles;

    return subtitles.map((subtitle, index) =>
      trimSubtitleCue(subtitle, subtitles[index + 1], energy),
    );
  } catch (error) {
    logMessage(`subtitle silence trim skipped: ${error}`, 'warning');
    return subtitles;
  }
}

function trimSubtitleCue(
  subtitle: SubtitleCue,
  nextSubtitle: SubtitleCue | undefined,
  energy: AudioEnergy,
): SubtitleCue {
  const [startTime, endTime, text] = subtitle;
  const startSeconds = subtitleTimeToSeconds(startTime);
  const endSeconds = subtitleTimeToSeconds(endTime);
  const nextStartSeconds = subtitleTimeToSeconds(nextSubtitle?.[0]);

  if (
    startSeconds === null ||
    endSeconds === null ||
    endSeconds <= startSeconds + MIN_SUBTITLE_DURATION_SECONDS
  ) {
    return subtitle;
  }

  const lastSpeechFrame = findLastSpeechFrame(energy, startSeconds, endSeconds);
  if (lastSpeechFrame === null) return subtitle;

  const speechEndSeconds =
    (lastSpeechFrame + 1) * energy.frameDurationSeconds +
    SILENCE_END_PADDING_SECONDS;
  const nextStartCap =
    nextStartSeconds !== null && nextStartSeconds > startSeconds
      ? nextStartSeconds
      : Number.POSITIVE_INFINITY;
  const trimmedEndSeconds = Math.min(
    endSeconds,
    speechEndSeconds,
    nextStartCap,
  );

  if (
    endSeconds - trimmedEndSeconds < MIN_TRAILING_SILENCE_SECONDS ||
    trimmedEndSeconds <= startSeconds + MIN_SUBTITLE_DURATION_SECONDS
  ) {
    return subtitle;
  }

  return [startTime, secondsToSubtitleTime(trimmedEndSeconds), text];
}

function findLastSpeechFrame(
  energy: AudioEnergy,
  startSeconds: number,
  endSeconds: number,
) {
  const startFrame = Math.max(
    0,
    Math.floor(startSeconds / energy.frameDurationSeconds),
  );
  const endFrame = Math.min(
    energy.frameDb.length - 1,
    Math.ceil(endSeconds / energy.frameDurationSeconds) - 1,
  );

  for (let i = endFrame; i >= startFrame; i -= 1) {
    if (energy.frameDb[i] >= energy.thresholdDb) return i;
  }
  return null;
}

export function analyzePcm16WavEnergy(audioFile: string): AudioEnergy | null {
  const buffer = fs.readFileSync(audioFile);
  const wavInfo = parsePcm16Wav(buffer);
  if (!wavInfo) return null;

  const samplesPerFrame = Math.max(
    1,
    Math.round((wavInfo.sampleRate * FRAME_MS) / 1000),
  );
  const frameDurationSeconds = samplesPerFrame / wavInfo.sampleRate;
  const bytesPerSample = 2;
  const bytesPerSampleFrame = bytesPerSample * wavInfo.channels;
  const sampleFrames = Math.floor(wavInfo.dataSize / bytesPerSampleFrame);
  const frameCount = Math.ceil(sampleFrames / samplesPerFrame);
  const frameDb: number[] = [];
  const dataEnd = wavInfo.dataOffset + wavInfo.dataSize;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const firstSampleFrame = frame * samplesPerFrame;
    const lastSampleFrame = Math.min(
      sampleFrames,
      firstSampleFrame + samplesPerFrame,
    );
    let sumSquares = 0;
    let count = 0;

    for (
      let sampleFrame = firstSampleFrame;
      sampleFrame < lastSampleFrame;
      sampleFrame += 1
    ) {
      for (let channel = 0; channel < wavInfo.channels; channel += 1) {
        const byteOffset =
          wavInfo.dataOffset +
          (sampleFrame * wavInfo.channels + channel) * bytesPerSample;
        if (byteOffset + bytesPerSample > dataEnd) break;
        const sample = buffer.readInt16LE(byteOffset) / 32768;
        sumSquares += sample * sample;
        count += 1;
      }
    }

    const rms = Math.sqrt(sumSquares / Math.max(count, 1));
    frameDb.push(20 * Math.log10(Math.max(rms, 1e-8)));
  }

  if (!frameDb.length) return null;
  return {
    frameDurationSeconds,
    frameDb,
    thresholdDb: estimateSpeechThresholdDb(frameDb),
  };
}

/** 能量法语音段：桥接 < 0.2s 的短静音（避免词内碎裂），丢弃 < 0.12s 的语音碎片。 */
const ENERGY_BRIDGE_SILENCE_SECONDS = 0.2;
const ENERGY_MIN_SPEECH_SECONDS = 0.12;

/**
 * 能量法语音段兜底（秒，`[{start,end}]`）：当 whisper 内部 VAD 关闭（如「文字最准」档）导致
 * `result.vadSegments` 为空时，用 RMS dB 阈值估算有声区间，供 `clampTriplesToSpeechSegments`
 * 把 token 夹回真实语音段、还原段间停顿。纯能量、零额外依赖/推理（复用 `analyzePcm16WavEnergy`）；
 * 解析失败 / 文件缺失 → 返回 `[]`（调用方 clamp 退化为恒等，不影响现有行为）。
 *
 * 注意：这**不是**「双 VAD」回潮——仅在 whisper VAD 关时跑一次轻量能量扫描，不依赖 sherpa /
 * 不做二次神经网络推理；VAD 开时调用方优先用 `result.vadSegments`，本函数不参与。
 */
export function energySpeechSegments(
  audioFile?: string,
): Array<{ start: number; end: number }> {
  if (!audioFile || !fs.existsSync(audioFile)) return [];
  const energy = analyzePcm16WavEnergy(audioFile);
  if (!energy) return [];
  const { frameDb, frameDurationSeconds: fd, thresholdDb } = energy;

  const raw: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  for (let i = 0; i < frameDb.length; i += 1) {
    const isSpeech = frameDb[i] >= thresholdDb;
    if (isSpeech && runStart < 0) runStart = i;
    else if (!isSpeech && runStart >= 0) {
      raw.push({ start: runStart * fd, end: i * fd });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    raw.push({ start: runStart * fd, end: frameDb.length * fd });
  }

  const bridged: Array<{ start: number; end: number }> = [];
  for (const seg of raw) {
    const last = bridged[bridged.length - 1];
    if (last && seg.start - last.end < ENERGY_BRIDGE_SILENCE_SECONDS) {
      last.end = seg.end;
    } else {
      bridged.push({ ...seg });
    }
  }
  return bridged.filter((s) => s.end - s.start >= ENERGY_MIN_SPEECH_SECONDS);
}

function parsePcm16Wav(buffer: Buffer): WavInfo | null {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let audioFormat = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (id === 'fmt ' && chunkStart + size <= buffer.length) {
      audioFormat = buffer.readUInt16LE(chunkStart);
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (id === 'data') {
      dataOffset = chunkStart;
      dataSize = Math.min(size, buffer.length - chunkStart);
    }

    offset = chunkStart + size + (size % 2);
  }

  if (
    audioFormat !== 1 ||
    bitsPerSample !== 16 ||
    channels <= 0 ||
    sampleRate <= 0 ||
    dataOffset <= 0 ||
    dataSize <= 0
  ) {
    return null;
  }

  return { dataOffset, dataSize, sampleRate, channels };
}

function estimateSpeechThresholdDb(frameDb: number[]) {
  const sorted = frameDb
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return -50;

  const noiseFloorDb = percentile(sorted, 0.15);
  const speechPeakDb = percentile(sorted, 0.95);
  return Math.max(Math.min(noiseFloorDb + 12, speechPeakDb - 6), -55);
}

function percentile(sortedValues: number[], ratio: number) {
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round((sortedValues.length - 1) * ratio)),
  );
  return sortedValues[index];
}

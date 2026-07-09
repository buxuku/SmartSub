/**
 * 参考音频编排层：ffmpeg 提取/裁剪/增益/重采样 + VAD 语音段 + 帧分析，
 * 把 referenceAudio.ts 的纯函数串成三个阶段（analyze / inspect / prepare）。
 *
 * 决策逻辑不在本文件（全部在 referenceAudio.ts，可单测）；本文件只做 IO。
 * ffmpeg 取消模式沿用 audioPipeline 的 runSave 形制。
 */
import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { TaskCancelledError } from '../taskContext';
import { stderrTail } from '../ffmpegErrorUtils';
import {
  readWavInfo,
  probeMediaDurationMs,
  transcodeToPcm16Wav,
} from '../dubbing/audioPipeline';
import type {
  CloneAnalysisView,
  CloneSegmentSuggestion,
  CloneTargetRange,
  VoiceQualityReport,
} from '../../../types/voiceClone';
import { CLONE_TARGET_RANGES } from '../../../types/voiceClone';
import {
  analyzeSampleFrames,
  buildQualityReport,
  clipSegmentsToRange,
  computeGainDb,
  energyEnvelope,
  energySegmentsFromFrames,
  planSilenceCompression,
  sliceFrameAnalysis,
  speechRmsDb,
  suggestCloneSegment,
  type FrameAnalysis,
  type SpeechSegmentMs,
} from './referenceAudio';

const FFMPEG_BIN = (ffmpegStatic as unknown as string).replace(
  'app.asar',
  'app.asar.unpacked',
);
ffmpeg.setFfmpegPath(FFMPEG_BIN);

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
        cleanupPartial();
        if (signal?.aborted) {
          reject(new TaskCancelledError());
          return;
        }
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

/** 读 16-bit PCM 单声道 wav 为 Float32Array（分析副本由我们自己产出，格式可信）。 */
function readWavSamples(file: string): {
  samples: Float32Array;
  sampleRate: number;
} {
  const info = readWavInfo(file);
  if (info.bitsPerSample !== 16 || info.channels !== 1) {
    throw new Error(
      `analysis wav must be 16-bit mono, got ${info.bitsPerSample}bit/${info.channels}ch`,
    );
  }
  const buf = fs.readFileSync(file);
  const count = Math.floor(info.dataBytes / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = buf.readInt16LE(info.dataOffset + i * 2) / 32768;
  }
  return { samples, sampleRate: info.sampleRate };
}

// ── 分析会话（向导期驻留 main 内存，帧级数据不过 IPC）───────────────────────

export interface CloneAnalysisSession {
  id: string;
  sourcePath: string;
  analysisWavPath: string;
  durationMs: number;
  segments: SpeechSegmentMs[];
  frames: FrameAnalysis;
  suggestion: CloneSegmentSuggestion | null;
  envelope: number[];
}

const sessions = new Map<string, CloneAnalysisSession>();

export function getCloneAnalysisSession(
  id: string,
): CloneAnalysisSession | undefined {
  return sessions.get(id);
}

export function disposeCloneAnalysisSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    if (fs.existsSync(s.analysisWavPath)) fs.unlinkSync(s.analysisWavPath);
  } catch {
    /* ignore */
  }
}

/** silero VAD 依赖的最小结构类型（lazy require；不用 typeof import——
 * 避免把 storeManager/electron 依赖链拉进 smoke 脚本的独立编译）。 */
interface SherpaVadRuntimeLike {
  detectSpeech(
    audioFile: string,
    vadModel: string,
    params: Record<string, number>,
  ): {
    id: string;
    result: Promise<{ segments: Array<{ start: number; end: number }> }>;
  };
}

/**
 * VAD 语音段（ms）：优先 Silero（内置随包，经 ASR 常驻 worker；lazy require，
 * 保持本模块纯 node 可引入），失败回落帧能量法（纯函数，零推理）。
 */
async function detectSpeechSegmentsMs(
  analysisWavPath: string,
  frames: FrameAnalysis,
): Promise<SpeechSegmentMs[]> {
  try {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { getSherpaFunasrRuntime } =
      require('../sherpaOnnx/sherpaFunasrRuntime') as {
        getSherpaFunasrRuntime: () => SherpaVadRuntimeLike;
      };
    const { resolveBundledVadPath } = require('../modelImport') as {
      resolveBundledVadPath: (root: string) => string;
    };
    const { getExtraResourcesPath } = require('../utils') as {
      getExtraResourcesPath: () => string;
    };
    /* eslint-enable @typescript-eslint/no-var-requires */
    const vadModel = resolveBundledVadPath(getExtraResourcesPath());
    if (!fs.existsSync(vadModel)) throw new Error('bundled vad missing');
    const { result } = getSherpaFunasrRuntime().detectSpeech(
      analysisWavPath,
      vadModel,
      {
        vad_threshold: 0.5,
        // 300ms 静音即断段：静音压缩规划需要比 800ms 阈值更细的边界。
        vad_min_silence_duration_ms: 300,
        vad_min_speech_duration_ms: 200,
        vad_max_speech_duration_s: 0,
      },
    );
    const { segments } = await result;
    return segments.map((s) => ({
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
    }));
  } catch {
    return energySegmentsFromFrames(frames);
  }
}

/**
 * 阶段 1 analyze：源媒体（音频或视频）→ 16k mono 分析副本 → VAD 语音段 +
 * 帧分析 → 推荐选段。会话驻留 main（选区复检/定稿不再重分析）。
 */
export async function analyzeCloneSource(
  sourcePath: string,
  engine: keyof typeof CLONE_TARGET_RANGES,
  opts?: { signal?: AbortSignal; tempDir: string },
): Promise<CloneAnalysisSession> {
  const tempDir = opts?.tempDir ?? path.join(process.cwd(), '.cache');
  fs.mkdirSync(tempDir, { recursive: true });
  const analysisWavPath = path.join(
    tempDir,
    `clone-analysis-${randomUUID()}.wav`,
  );
  const command = ffmpeg(sourcePath)
    .noVideo()
    .audioFrequency(16000)
    .audioChannels(1)
    .audioCodec('pcm_s16le')
    .outputOptions('-y');
  await runSave(command, analysisWavPath, opts?.signal);

  const { samples, sampleRate } = readWavSamples(analysisWavPath);
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  const frames = analyzeSampleFrames(samples, sampleRate);
  const segments = await detectSpeechSegmentsMs(analysisWavPath, frames);
  // 携帧数据：能量感知选段（避开 VAD 误判语音的微弱区域）。
  const suggestion = suggestCloneSegment(
    segments,
    durationMs,
    CLONE_TARGET_RANGES[engine],
    frames,
  );

  const session: CloneAnalysisSession = {
    id: randomUUID(),
    sourcePath,
    analysisWavPath,
    durationMs,
    segments,
    frames,
    suggestion,
    envelope: energyEnvelope(frames),
  };
  sessions.set(session.id, session);
  return session;
}

export function analysisView(session: CloneAnalysisSession): CloneAnalysisView {
  return {
    analysisWavPath: session.analysisWavPath,
    durationMs: session.durationMs,
    speechSegments: session.segments,
    suggestion: session.suggestion,
    envelope: session.envelope,
  };
}

/** 阶段 2 inspect：选区质检（复用会话帧数据，零 IO）。 */
export function inspectCloneRange(
  session: CloneAnalysisSession,
  startMs: number,
  endMs: number,
  target: CloneTargetRange,
): VoiceQualityReport {
  const from = Math.max(0, Math.min(startMs, session.durationMs));
  const to = Math.max(from, Math.min(endMs, session.durationMs));
  return buildQualityReport({
    rangeStartMs: from,
    rangeEndMs: to,
    segments: clipSegmentsToRange(session.segments, from, to),
    frames: sliceFrameAnalysis(session.frames, from, to),
    target,
  });
}

/** 本地降噪（gtcrn 随包模型，经 ASR 常驻 worker；lazy require 保持纯 node 可引入）。 */
async function denoiseWavInPlace(
  wavPath: string,
  signal?: AbortSignal,
): Promise<void> {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { getSherpaFunasrRuntime } =
    require('../sherpaOnnx/sherpaFunasrRuntime') as {
      getSherpaFunasrRuntime: () => {
        denoise: (
          audioFile: string,
          denoiseModel: string,
          outFile: string,
        ) => { id: string; result: Promise<void> };
      };
    };
  const { resolveBundledDenoisePath } = require('../modelImport') as {
    resolveBundledDenoisePath: (root: string) => string;
  };
  const { getExtraResourcesPath } = require('../utils') as {
    getExtraResourcesPath: () => string;
  };
  /* eslint-enable @typescript-eslint/no-var-requires */
  const model = resolveBundledDenoisePath(getExtraResourcesPath());
  if (!fs.existsSync(model)) throw new Error('内置降噪模型缺失');
  const denoised = wavPath.replace(/\.wav$/i, '.denoised.wav');
  await getSherpaFunasrRuntime().denoise(wavPath, model, denoised).result;
  // gtcrn 输出 16k：重采样回 24k mono 16-bit（与克隆参考合同一致）。
  const resampled = wavPath.replace(/\.wav$/i, '.dn24k.wav');
  await transcodeToPcm16Wav(denoised, resampled, {
    sampleRate: 24000,
    signal,
  });
  fs.copyFileSync(resampled, wavPath);
  fs.rmSync(denoised, { force: true });
  fs.rmSync(resampled, { force: true });
}

/**
 * 阶段 3 prepare：从「原始源媒体」按选区定稿参考音频（不用 16k 分析副本，
 * 保留源音质）——静音压缩区间 → filter_complex 一次成型（atrim 拼接 +
 * 可选增益 + 重采样 24k mono 16-bit）→ 可选本地降噪（gtcrn，定稿复测以
 * 降噪后产物为准）。返回产物路径与定稿质检报告。
 */
export async function prepareCloneReference(
  session: CloneAnalysisSession,
  startMs: number,
  endMs: number,
  target: CloneTargetRange,
  outWavPath: string,
  opts?: { signal?: AbortSignal; denoise?: boolean },
): Promise<{ refWavPath: string; report: VoiceQualityReport }> {
  const from = Math.max(0, Math.min(startMs, session.durationMs));
  const to = Math.max(from, Math.min(endMs, session.durationMs));
  const rangeSegments = clipSegmentsToRange(session.segments, from, to);
  // 选区相对坐标的语音段 → 保留区间规划。
  const relative = rangeSegments.map((s) => ({
    startMs: s.startMs - from,
    endMs: s.endMs - from,
  }));
  const keeps = planSilenceCompression(relative, to - from);
  if (keeps.length === 0) {
    throw new Error('选区内没有可用的语音内容');
  }

  const rangeFrames = sliceFrameAnalysis(session.frames, from, to);
  const rmsDb = speechRmsDb(rangeFrames, rangeSegments, from);
  const gainDb = computeGainDb(rmsDb, rangeFrames.peakDb);

  // filter_complex：逐保留区间 atrim（绝对时间 = from + 相对区间）→ concat →
  // 可选 volume 增益。输出统一 24kHz mono 16-bit（zipvoice 模型采样率）。
  const parts: string[] = [];
  const labels: string[] = [];
  keeps.forEach((iv, i) => {
    const s = ((from + iv.startMs) / 1000).toFixed(3);
    const e = ((from + iv.endMs) / 1000).toFixed(3);
    parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[k${i}]`);
    labels.push(`[k${i}]`);
  });
  const gainFilter = gainDb > 0 ? `,volume=${gainDb}dB` : '';
  parts.push(
    `${labels.join('')}concat=n=${keeps.length}:v=0:a=1${gainFilter}[out]`,
  );

  fs.mkdirSync(path.dirname(outWavPath), { recursive: true });
  const command = ffmpeg(session.sourcePath)
    .complexFilter(parts, 'out')
    .audioFrequency(24000)
    .audioChannels(1)
    .audioCodec('pcm_s16le')
    .outputOptions('-y');
  await runSave(command, outWavPath, opts?.signal);

  // 可选本地降噪（噪音黄牌素材的兜底；会略损相似度，由用户显式开启）。
  if (opts?.denoise) {
    await denoiseWavInPlace(outWavPath, opts.signal);
  }

  // 定稿复测：按最终产物重算报告（时长/静音已变，语音段用能量法就地重估）。
  const final = readWavSamples(outWavPath);
  const finalDurationMs = Math.round(
    (final.samples.length / final.sampleRate) * 1000,
  );
  const finalFrames = analyzeSampleFrames(final.samples, final.sampleRate);
  const finalSegments: SpeechSegmentMs[] =
    energySegmentsFromFrames(finalFrames);
  const report = buildQualityReport({
    rangeStartMs: 0,
    rangeEndMs: finalDurationMs,
    segments: clipSegmentsToRange(finalSegments, 0, finalDurationMs),
    frames: finalFrames,
    target,
  });
  return { refWavPath: outWavPath, report };
}

export { probeMediaDurationMs };

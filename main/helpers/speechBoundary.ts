import fs from 'fs';
import { logMessage } from './storeManager';
import { getExtraResourcesPath } from './utils';
import { resolveBundledVadPath } from './modelImport';
import { isSherpaLibInstalled } from './sherpaOnnx/sherpaLibPaths';
import { getSherpaFunasrRuntime } from './sherpaOnnx/sherpaFunasrRuntime';
import { analyzePcm16WavEnergy, type AudioEnergy } from './subtitleTiming';

/**
 * 语音边界源（混合策略，方案 builtin-subtitle-timeline-0fork）：
 * 对 16k/单声道/PCM16 WAV 返回语音段 `[{start,end}]`（秒）。
 *
 * 优先级：
 *   1) Silero VAD（经 sherpa「只跑 VAD」入口；原生库 + silero_vad.onnx 随包内置，零下载）；
 *   2) 能量阈值法（RMS dB，复用 PR #341 的 analyzePcm16WavEnergy）；
 *   3) 都不可用 → 返回空数组，由调用方优雅降级（退回连续时间轴，不报错）。
 *
 * 仅供主进程使用（依赖 sherpa worker / electron 路径）。
 */
export interface SpeechSegment {
  start: number;
  end: number;
}

/** Silero VAD 参数（边界检测用固定默认值，与 getVadSettings 默认一致；后续可设置化）。 */
const DEFAULT_VAD_PARAMS = {
  vad_threshold: 0.5,
  vad_min_speech_duration_ms: 250,
  vad_min_silence_duration_ms: 100,
  vad_max_speech_duration_s: 0,
};

/** 能量法：桥接 < 0.2s 的短静音（避免词内碎裂），丢弃 < 0.12s 的语音碎片。 */
const ENERGY_BRIDGE_SILENCE_SECONDS = 0.2;
const ENERGY_MIN_SPEECH_SECONDS = 0.12;

export async function getSpeechSegments(
  audioFile: string,
): Promise<SpeechSegment[]> {
  if (!audioFile || !fs.existsSync(audioFile)) return [];

  const silero = await trySileroSegments(audioFile);
  if (silero && silero.length) return silero;

  const energy = energySegments(audioFile);
  if (energy.length) return energy;

  return [];
}

/**
 * 经 sherpa「只跑 VAD」入口取语音段。sherpa 原生库未安装（dev 未 `yarn sherpa:fetch`）
 * 或加载/解析失败 → 返回 null（表示「Silero 不可用」，交由调用方回退能量法）。
 */
async function trySileroSegments(
  audioFile: string,
): Promise<SpeechSegment[] | null> {
  if (!isSherpaLibInstalled()) return null;
  const vadModel = resolveBundledVadPath(getExtraResourcesPath());
  if (!fs.existsSync(vadModel)) return null;

  try {
    const { result } = getSherpaFunasrRuntime().detectSpeech(
      audioFile,
      vadModel,
      DEFAULT_VAD_PARAMS,
    );
    const { segments } = await result;
    return (segments || [])
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
      .map((s) => ({ start: s.start, end: s.end }));
  } catch (error) {
    logMessage(
      `silero vad boundary skipped, fallback to energy: ${error}`,
      'warning',
    );
    return null;
  }
}

/** 能量法：把连续「有声帧」合并为语音段（含短静音桥接 + 碎片过滤）。 */
function energySegments(audioFile: string): SpeechSegment[] {
  let energy: AudioEnergy | null = null;
  try {
    energy = analyzePcm16WavEnergy(audioFile);
  } catch (error) {
    logMessage(`energy boundary analysis skipped: ${error}`, 'warning');
    return [];
  }
  if (!energy) return [];

  const fd = energy.frameDurationSeconds;
  const bridgeFrames = Math.round(ENERGY_BRIDGE_SILENCE_SECONDS / fd);
  const raw: SpeechSegment[] = [];

  let runStart = -1;
  for (let i = 0; i < energy.frameDb.length; i += 1) {
    const speech = energy.frameDb[i] >= energy.thresholdDb;
    if (speech && runStart < 0) {
      runStart = i;
    } else if (!speech && runStart >= 0) {
      raw.push({ start: runStart * fd, end: i * fd });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    raw.push({ start: runStart * fd, end: energy.frameDb.length * fd });
  }

  // 桥接短静音：相邻段间隔 < bridgeFrames 帧则并为一段。
  const bridged: SpeechSegment[] = [];
  for (const seg of raw) {
    const prev = bridged[bridged.length - 1];
    if (prev && seg.start - prev.end < bridgeFrames * fd) {
      prev.end = seg.end;
    } else {
      bridged.push({ ...seg });
    }
  }

  return bridged.filter((s) => s.end - s.start >= ENERGY_MIN_SPEECH_SECONDS);
}

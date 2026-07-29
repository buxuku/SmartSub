import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import ffmpegStatic from 'ffmpeg-static';
import ffmpeg from 'fluent-ffmpeg';
import { logMessage, store } from '../storeManager';
import { ensureTempDir } from '../fileUtils';
import {
  getInstalledFunasrAsrModels,
  getFunasrModelDir,
  getFunasrVadModelPath,
  isFunasrReady,
  resolveFunasrAsrSelection,
} from '../funasrModelCatalog';
import { isSherpaLibInstalled } from '../sherpaOnnx/sherpaLibPaths';
import { getSherpaFunasrRuntime } from '../sherpaOnnx/sherpaFunasrRuntime';
import { getAsrProviders } from '../asrProviderManager';
import {
  getAsrProviderType,
  isAsrProviderConfigured,
  parseAsrModels,
} from '../../../types/asrProvider';
import { getAsrTranscriber } from '../../service/asr';
import { acquireTranscribeSlot } from '../engines/transcribeGate';
import {
  getFasterWhisperModelsInstalled,
  getFasterWhisperModelsPath,
  resolveCt2ModelSnapshotDir,
} from '../modelCatalog';
import { isRuntimeInstalled } from '../pythonRuntime/paths';
import { getPythonRuntimeManager } from '../pythonRuntime';
import { getModelsInstalled, getPath, loadWhisperAddon } from '../whisper';
import { getWhisperLanguage } from '../engines/transcribeShared';
import {
  isTaskCancelledError,
  isWhisperCancelledResult,
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../taskContext';
import {
  joinSegmentTexts,
  pickSmallestWhisperModel,
} from './referenceTranscribeUtils';

export {
  joinSegmentTexts,
  pickSmallestWhisperModel,
  WHISPER_MODEL_SIZE_ORDER,
} from './referenceTranscribeUtils';

const FFMPEG_BIN = (ffmpegStatic as unknown as string).replace(
  'app.asar',
  'app.asar.unpacked',
);
ffmpeg.setFfmpegPath(FFMPEG_BIN);

/**
 * 参考文本自动转写：窄本地级联 SenseVoice → faster-whisper → builtin ggml
 * → 云 ASR → available=false（向导降级手动输入）。轻量 wav→text，不经任务管线。
 */
export interface ReferenceTranscribeResult {
  available: boolean;
  text?: string;
  /** 转写来源展示名（SenseVoice / faster-whisper / Whisper / 云实例名）。 */
  engineLabel?: string;
  error?: string;
}

/** 单候选成功结果（含展示名）。 */
interface CandidateHit {
  text: string;
  engineLabel: string;
}

/** 切选区临时 wav（分析副本已是 16k mono pcm16，仅裁剪）。 */
async function cutRangeWav(
  analysisWavPath: string,
  startMs: number,
  endMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const outPath = path.join(
    ensureTempDir(),
    `clone-ref-asr-${randomUUID()}.wav`,
  );
  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg(analysisWavPath)
      .setStartTime(startMs / 1000)
      .setDuration(Math.max(0.1, (endMs - startMs) / 1000))
      .audioCodec('pcm_s16le')
      .outputOptions('-y');
    const onAbort = () => {
      try {
        command.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    command
      .on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      })
      .on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      })
      .save(outPath);
  });
  return outPath;
}

async function transcribeWithLocalFunasr(
  wavPath: string,
  language: 'zh' | 'en',
  signal?: AbortSignal,
): Promise<CandidateHit | null> {
  throwIfSignalCancelled(signal);
  if (!isSherpaLibInstalled() || !isFunasrReady()) return null;
  const installed = getInstalledFunasrAsrModels();
  // 优先 SenseVoice；未装则 catalog 回落其它已装 FunASR ASR。
  const selection = resolveFunasrAsrSelection('sensevoice-small', installed);
  if (!selection) return null;

  const release = await acquireTranscribeSlot('funasr', signal);
  try {
    throwIfSignalCancelled(signal);
    const asrDir = getFunasrModelDir(selection.id);
    const { id, result } = getSherpaFunasrRuntime().transcribe(
      {
        asrModel: path.join(asrDir, 'model.int8.onnx'),
        tokens: path.join(asrDir, 'tokens.txt'),
        vadModel: getFunasrVadModelPath(),
        modelType: selection.modelType,
        params: {
          vad_threshold: 0.5,
          vad_min_silence_duration_ms: 300,
          vad_min_speech_duration_ms: 200,
          vad_max_speech_duration_s: 0,
          num_threads: 2,
          provider: 'cpu',
          language: 'auto',
          use_itn: true,
        },
      },
      wavPath,
    );
    const onAbort = () => getSherpaFunasrRuntime().cancel(id);
    if (signal?.aborted) {
      onAbort();
      throw new TaskCancelledError();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const { segments } = await result;
      const text = joinSegmentTexts(segments, language);
      if (!text) return null;
      const engineLabel =
        selection.id === 'sensevoice-small' ? 'SenseVoice' : selection.id;
      return { text, engineLabel };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    release();
  }
}

async function transcribeWithFasterWhisper(
  wavPath: string,
  language: 'zh' | 'en',
  signal?: AbortSignal,
): Promise<CandidateHit | null> {
  throwIfSignalCancelled(signal);
  if (!isRuntimeInstalled('faster-whisper')) return null;
  const installed = getFasterWhisperModelsInstalled();
  const modelId = pickSmallestWhisperModel(installed);
  if (!modelId) return null;
  const modelSnapshotDir = resolveCt2ModelSnapshotDir(modelId);
  if (!modelSnapshotDir) return null;

  const release = await acquireTranscribeSlot('fasterWhisper', signal);
  try {
    throwIfSignalCancelled(signal);
    const settings = (store.get('settings') || {}) as Record<string, unknown>;
    const manager = getPythonRuntimeManager();
    const engineInfo = await manager.ensureStarted('faster-whisper');
    if (!engineInfo?.engines?.faster_whisper) {
      throw new Error('faster-whisper not available in python runtime');
    }
    const configuredDevice = (settings.fasterWhisperDevice || 'auto') as
      | 'auto'
      | 'cpu'
      | 'cuda';
    const params = {
      engine: 'faster_whisper',
      audio_file: wavPath,
      model: modelSnapshotDir,
      local_files_only: true,
      download_root: getFasterWhisperModelsPath(),
      language: getWhisperLanguage(language),
      compute_type: (settings.fasterWhisperComputeType as string) || 'auto',
      initial_prompt: '',
      word_timestamps: false,
      device: configuredDevice,
    };
    const { id, result } = manager.transcribe(params);
    const onAbort = () => manager.cancel(id);
    if (signal?.aborted) {
      onAbort();
      throw new TaskCancelledError();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const transcription = await result;
      if (signal?.aborted) throw new TaskCancelledError();
      const text = joinSegmentTexts(transcription?.segments || [], language);
      return text ? { text, engineLabel: 'faster-whisper' } : null;
    } catch (error) {
      if (
        signal?.aborted ||
        (error as { code?: string })?.code === 'cancelled'
      ) {
        throw new TaskCancelledError();
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    release();
  }
}

async function transcribeWithBuiltinWhisper(
  wavPath: string,
  language: 'zh' | 'en',
  signal?: AbortSignal,
): Promise<CandidateHit | null> {
  throwIfSignalCancelled(signal);
  const installed = getModelsInstalled();
  const model = pickSmallestWhisperModel(installed);
  if (!model) return null;

  const modelPath = path.join(getPath('modelsPath'), `ggml-${model}.bin`);
  if (!fs.existsSync(modelPath)) return null;

  const { whisperAsync } = await loadWhisperAddon(model);
  throwIfSignalCancelled(signal);

  const settings = (store.get('settings') || {}) as Record<string, unknown>;
  const gpuMode = (settings.gpuMode as string) || 'auto';
  const result = await whisperAsync({
    language: getWhisperLanguage(language),
    model: modelPath,
    fname_inp: wavPath,
    use_gpu: gpuMode !== 'cpu',
    flash_attn: false,
    no_prints: true,
    comma_in_time: false,
    translate: false,
    no_timestamps: false,
    audio_ctx: 0,
    token_timestamps: false,
    max_len: 0,
    print_progress: false,
    prompt: '',
    vad: false,
    signal,
  });

  if (isWhisperCancelledResult(result) || signal?.aborted) {
    throw new TaskCancelledError();
  }

  const text = joinSegmentTexts(result?.transcription || [], language);
  return text ? { text, engineLabel: 'Whisper' } : null;
}

async function transcribeWithCloudAsr(
  wavPath: string,
  language: 'zh' | 'en',
  signal?: AbortSignal,
): Promise<CandidateHit | null> {
  throwIfSignalCancelled(signal);
  const provider = getAsrProviders().find((p) => {
    const type = getAsrProviderType(p.type);
    return (
      type && isAsrProviderConfigured(p, type) && getAsrTranscriber(p.type)
    );
  });
  if (!provider) return null;
  const transcriber = getAsrTranscriber(provider.type)!;
  const models = parseAsrModels(provider);
  const result = await transcriber(provider, {
    audioPath: wavPath,
    model: String(provider.model || models[0] || 'whisper-1'),
    language,
    signal,
  });
  const text = (result.text || '').trim();
  return text ? { text, engineLabel: provider.name } : null;
}

/** 跑一个候选：取消向上抛；其它失败记 warning 并继续。 */
async function tryCandidate(
  name: string,
  signal: AbortSignal | undefined,
  run: () => Promise<CandidateHit | null>,
): Promise<CandidateHit | null> {
  try {
    return await run();
  } catch (e) {
    if (isTaskCancelledError(e) || signal?.aborted) throw e;
    logMessage(`clone ref ${name} asr failed: ${e}`, 'warning');
    return null;
  }
}

export async function transcribeReferenceRange(
  analysisWavPath: string,
  startMs: number,
  endMs: number,
  language: 'zh' | 'en',
  signal?: AbortSignal,
): Promise<ReferenceTranscribeResult> {
  if (!fs.existsSync(analysisWavPath)) {
    return { available: false, error: 'analysis wav missing' };
  }
  throwIfSignalCancelled(signal);

  let rangeWav: string | null = null;
  try {
    rangeWav = await cutRangeWav(analysisWavPath, startMs, endMs, signal);
    throwIfSignalCancelled(signal);

    const localFunasr = await tryCandidate('funasr', signal, () =>
      transcribeWithLocalFunasr(rangeWav!, language, signal),
    );
    if (localFunasr) {
      return {
        available: true,
        text: localFunasr.text,
        engineLabel: localFunasr.engineLabel,
      };
    }

    const fasterWhisper = await tryCandidate('faster-whisper', signal, () =>
      transcribeWithFasterWhisper(rangeWav!, language, signal),
    );
    if (fasterWhisper) {
      return {
        available: true,
        text: fasterWhisper.text,
        engineLabel: fasterWhisper.engineLabel,
      };
    }

    const builtin = await tryCandidate('builtin', signal, () =>
      transcribeWithBuiltinWhisper(rangeWav!, language, signal),
    );
    if (builtin) {
      return {
        available: true,
        text: builtin.text,
        engineLabel: builtin.engineLabel,
      };
    }

    const cloud = await tryCandidate('cloud', signal, () =>
      transcribeWithCloudAsr(rangeWav!, language, signal),
    );
    if (cloud) {
      return {
        available: true,
        text: cloud.text,
        engineLabel: cloud.engineLabel,
      };
    }

    return { available: false };
  } finally {
    if (rangeWav) {
      try {
        fs.unlinkSync(rangeWav);
      } catch {
        /* ignore */
      }
    }
  }
}

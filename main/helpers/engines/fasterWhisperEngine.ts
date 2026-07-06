import fs from 'fs';
import type { EngineStatus, PyEngineManifest } from '../../../types/engine';
import {
  isRuntimeInstalled,
  readEngineManifest,
  normalizePyEngineVariant,
  getParkedVariant,
} from '../pythonRuntime/paths';
import {
  getFasterWhisperModelsPath,
  resolveCt2ModelSnapshotDir,
} from '../modelCatalog';
import { formatSrtContent } from '../fileUtils';
import { logMessage, store } from '../storeManager';
import { getPythonRuntimeManager } from '../pythonRuntime';
import {
  subtitleCueFromSegment,
  trimSubtitleTrailingSilence,
} from '../subtitleTiming';
import {
  composeWordCues,
  getSubtitleCueOptions,
  wordsToTriples,
} from '../subtitleSegmentation';
import {
  getTaskContext,
  isTaskCancelledError,
  TaskCancelledError,
} from '../taskContext';
import { toFasterWhisperModel } from './modelMap';
import {
  getNumericSetting,
  getWhisperLanguage,
  getFasterWhisperAntiRepetitionParams,
} from './transcribeShared';
import { resolveEffectiveSettings } from './outcomePresets';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

/**
 * 判定是否为 CUDA 运行库（cuBLAS/cuDNN/cudart）缺失或无法加载类错误。
 * 典型：CTranslate2 抛 "Library cublas64_12.dll is not found or cannot be loaded"。
 */
function isCudaRuntimeError(error: unknown): boolean {
  const msg = (
    error instanceof Error ? error.message : String(error ?? '')
  ).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('cublas') ||
    msg.includes('cudnn') ||
    msg.includes('cudart') ||
    msg.includes('cuda')
  );
}

/**
 * CUDA 运行库不可用时面向用户的可操作提示：引导改用 CPU 设备或更换引擎。
 */
function formatCudaRuntimeHint(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return `faster-whisper GPU(CUDA) 加速所需的运行库（cuBLAS/cuDNN）缺失或无法加载，无法使用 CUDA。请在「资源中心 → 引擎 → faster-whisper」将「计算设备」改为 CPU，或改用其他转写引擎。原始错误：${raw}`;
}

/** 在途转写 id 集合：任务级并发下可能同时存在多个（排队+执行），取消须精确到 id。 */
const activeFasterWhisperTranscribeIds = new Set<string>();

function cancelFasterWhisperTranscription(): void {
  const manager = getPythonRuntimeManager();
  activeFasterWhisperTranscribeIds.forEach((id) => manager.cancel(id));
  activeFasterWhisperTranscribeIds.clear();
}

/**
 * 安装版本展示：优先真实 engineVersion；老安装（version='latest'）回退 sha256 短哈希，
 * 避免显示无意义的 "vlatest"。
 */
function formatInstalledVersion(
  manifest: PyEngineManifest | null,
): string | undefined {
  if (!manifest) return undefined;
  if (manifest.engineVersion) return manifest.engineVersion;
  if (manifest.version && manifest.version !== 'latest')
    return manifest.version;
  if (manifest.sha256) return manifest.sha256.slice(0, 7);
  return undefined;
}

/**
 * 批次预热：在音频抽取的同时，让 sidecar 预加载所选 CT2 模型并写满 _model_cache，
 * 使首个 transcribe 直接命中。sidecar 为「先加载模型、再发 progress(0%)」，且重依赖
 * （ctranslate2/av/tokenizers）已惰性推迟到首个 transcribe/preload；若不预热，首个文件
 * 会把导入 + 模型加载的冷启动成本全压在关键路径上，表现为长时间「卡在 0% 无进度」
 * （取消重试因缓存命中而恢复）。预热与 ffmpeg 抽取并行，失败一律非致命。
 *
 * 参数（model/device/compute_type/download_root）必须与 transcribe 完全一致，
 * 否则 _get_model 的缓存 key 不匹配、预热白做。
 */
function prewarmFasterWhisper(formData: Record<string, unknown>): void {
  try {
    if (!isRuntimeInstalled('faster-whisper')) return;
    const { model } = formData as { model?: string };
    const modelId = toFasterWhisperModel(model);
    const modelSnapshotDir = resolveCt2ModelSnapshotDir(modelId);
    if (!modelSnapshotDir) return;
    const settings = store.get('settings');
    const params = {
      engine: 'faster_whisper',
      model: modelSnapshotDir,
      local_files_only: true,
      download_root: getFasterWhisperModelsPath(),
      device: settings.fasterWhisperDevice || 'auto',
      compute_type: settings.fasterWhisperComputeType || 'auto',
    };
    const manager = getPythonRuntimeManager();
    // taskProcessor 在 ensureStarted('faster-whisper') 成功后才调用本函数，
    // 此处再确认一次 sidecar 在跑且正服务 faster-whisper，避免引擎已被切走时空发。
    if (manager.activeEngineId !== 'faster-whisper' || !manager.isRunning)
      return;
    // 预加载在 sidecar worker 线程进行，给足冗余超时；任何错误（含旧引擎
    // method_not_found）都吞掉——首个 transcribe 仍会按需加载，预热只是优化。
    manager
      .request('preload', params, { timeoutMs: 10 * 60_000 })
      .then(() => logMessage('faster-whisper model prewarm done', 'info'))
      .catch((error) =>
        logMessage(`faster-whisper model prewarm skipped: ${error}`, 'warning'),
      );
    logMessage('faster-whisper model prewarm started', 'info');
  } catch (error) {
    logMessage(`faster-whisper prewarm error (non-fatal): ${error}`, 'warning');
  }
}

/**
 * 使用 Python sidecar 中的 faster-whisper 生成字幕。
 * 取消与内置 whisper 一致走 AbortSignal：信号触发即通知 sidecar 逐段取消。
 */
async function transcribeFasterWhisper(
  ctx: TranscribeContext,
): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  const { tempAudioFile, srtFile } = file;
  const { model, sourceLanguage, prompt } = formData as {
    model?: string;
    sourceLanguage?: string;
    prompt?: string;
  };
  // 逐任务运行时派生（字幕效果档位 → useVAD / 抗重复参数包），不回写全局。
  const settings = resolveEffectiveSettings(
    formData,
    store.get('settings') as Record<string, unknown>,
  );

  const manager = getPythonRuntimeManager();
  let engineInfo;
  try {
    engineInfo = await manager.ensureStarted('faster-whisper');
  } catch (error) {
    throw new Error(
      `faster-whisper engine unavailable: ${error?.message || error}`,
    );
  }
  if (!engineInfo?.engines?.faster_whisper) {
    throw new Error(
      'faster-whisper is not available in the python engine runtime',
    );
  }

  const modelId = toFasterWhisperModel(model);
  const modelSnapshotDir = resolveCt2ModelSnapshotDir(modelId);
  if (!modelSnapshotDir) {
    throw new Error(
      `faster-whisper model "${modelId}" not found in ${getFasterWhisperModelsPath()}. Download it from Resource Hub > Models.`,
    );
  }
  const configuredDevice = (settings.fasterWhisperDevice || 'auto') as
    | 'auto'
    | 'cpu'
    | 'cuda';
  // device 逐次尝试注入，便于 CUDA 运行库缺失时回退 CPU 重试；其余参数对各设备一致。
  const baseParams = {
    engine: 'faster_whisper',
    audio_file: tempAudioFile,
    model: modelSnapshotDir,
    local_files_only: true,
    download_root: getFasterWhisperModelsPath(),
    language: getWhisperLanguage(sourceLanguage),
    compute_type: settings.fasterWhisperComputeType || 'auto',
    initial_prompt: prompt || '',
    // faster-whisper #1119：开启词级时间戳，让 segment.end 对齐到真实末词，
    // 避免开 VAD 时段尾时间被拉到下一段开头。旧 sidecar 忽略该参数也无害。
    word_timestamps: true,
    vad: settings.useVAD !== false,
    vad_threshold: getNumericSetting(settings.vadThreshold, 0.5),
    vad_min_speech_duration_ms: getNumericSetting(
      settings.vadMinSpeechDuration,
      250,
    ),
    vad_min_silence_duration_ms: getNumericSetting(
      settings.vadMinSilenceDuration,
      100,
    ),
    // SmartSub 约定 0 = 不限制；sidecar 会映射为 faster-whisper 的 inf。
    vad_max_speech_duration_s: getNumericSetting(
      settings.vadMaxSpeechDuration,
      0,
    ),
    vad_speech_pad_ms: getNumericSetting(settings.vadSpeechPad, 200),
    // 抗幻觉/抗重复参数（仅开关开启时注入；关闭则不下发，sidecar 回落默认）。
    ...getFasterWhisperAntiRepetitionParams(settings),
  };

  const signal = ctx.signal ?? getTaskContext()?.signal;

  // 单次转写尝试：按指定 device 下发，内含进度回传与取消处理。
  const runAttempt = async (device: 'auto' | 'cpu' | 'cuda') => {
    const params = { ...baseParams, device };
    logMessage(
      `fasterWhisperParams: ${JSON.stringify(params, null, 2)}`,
      'info',
    );
    event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

    // 诊断：记录「下发 transcribe → sidecar 首个 progress」的墙钟间隔。首任务卡 0% 时，
    // 这段间隔即为 sidecar 侧导入重依赖 + 加载模型（或等待 preload 占用的模型锁）的耗时；
    // 配合 sidecar 端 [py-engine] 日志即可定位卡在哪一步。
    const dispatchAt = Date.now();
    logMessage(
      `faster-whisper: dispatching transcribe to sidecar (device=${device})`,
      'info',
    );
    let firstProgressLogged = false;
    const { id, result } = manager.transcribe(params, {
      onProgress: (percent) => {
        if (!firstProgressLogged) {
          firstProgressLogged = true;
          logMessage(
            `faster-whisper: first progress from sidecar after ${Date.now() - dispatchAt}ms`,
            'info',
          );
        }
        event.sender.send(
          'taskProgressChange',
          file,
          'extractSubtitle',
          percent,
        );
      },
    });
    activeFasterWhisperTranscribeIds.add(id);

    const onAbort = () => {
      if (activeFasterWhisperTranscribeIds.has(id)) manager.cancel(id);
    };
    if (signal?.aborted) {
      manager.cancel(id);
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    try {
      return await result;
    } catch (error) {
      // 用户取消：sidecar 回 {code:'cancelled'}。转成取消语义，避免被标记为转写错误。
      if (
        signal?.aborted ||
        (error as { code?: string })?.code === 'cancelled'
      ) {
        throw new TaskCancelledError();
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      activeFasterWhisperTranscribeIds.delete(id);
    }
  };

  let transcription;
  try {
    transcription = await runAttempt(configuredDevice);
  } catch (error) {
    if (isTaskCancelledError(error)) throw error;
    // CUDA 运行库（cuBLAS/cuDNN）缺失或加载失败：
    // device=auto 时自动回退 CPU 重试一次；显式选 cuda 则给出可操作的中文提示。
    if (isCudaRuntimeError(error)) {
      if (configuredDevice === 'auto') {
        logMessage(
          `faster-whisper: CUDA 运行库加载失败，自动回退 CPU 重试（原始错误：${
            error instanceof Error ? error.message : String(error)
          }）`,
          'warning',
        );
        try {
          transcription = await runAttempt('cpu');
        } catch (cpuError) {
          if (isTaskCancelledError(cpuError)) throw cpuError;
          throw new Error(formatCudaRuntimeHint(cpuError));
        }
      } else {
        throw new Error(formatCudaRuntimeHint(error));
      }
    } else {
      throw error;
    }
  }

  // 边界：转写正常返回但此刻已被取消，同样按取消处理，避免写出半截字幕。
  if (signal?.aborted) {
    throw new TaskCancelledError();
  }

  // 任务级 maxSubtitleChars：仅「正数上限」才从词级时间戳重建成句（composeWordCues
  // 统一出口，含硬切回溯，宽度由真实词时间保证）；0 = 智能断句与 -1 = 不限制长度都
  // 沿用引擎段级断句——whisper 原生按句分段，本就不按宽度硬切。
  const segments = transcription?.segments || [];
  const cueOptions = getSubtitleCueOptions(formData as Record<string, unknown>);
  let subtitles;
  if (cueOptions && Number.isFinite(cueOptions.maxWidth)) {
    const wordTriples = segments.flatMap((segment) => {
      const triples = wordsToTriples(segment?.words);
      return triples.length > 0 ? triples : [subtitleCueFromSegment(segment)];
    });
    subtitles = composeWordCues(
      wordTriples,
      formData as Record<string, unknown>,
    );
  } else {
    subtitles = segments.map(subtitleCueFromSegment);
  }
  subtitles = trimSubtitleTrailingSilence(subtitles, tempAudioFile);
  const formattedSrt = formatSrtContent(subtitles);
  await fs.promises.writeFile(srtFile, formattedSrt);

  event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'done' });
  logMessage(
    `generate subtitle done (faster-whisper, language=${transcription?.language})`,
    'info',
  );
  return srtFile;
}

export const fasterWhisperEngineAdapter: TranscriptionEngineAdapter = {
  id: 'fasterWhisper',
  displayName: 'faster-whisper',
  requiresRuntime: true,
  pyEngineId: 'faster-whisper',

  async isAvailable(): Promise<EngineStatus> {
    // 安装状态以「自包含运行时已落盘（内嵌解释器 + main.py + site-packages）+ manifest 存在」为准；
    // 运行时探活（冷启动 ping）推迟到真正转写时进行，避免解释器首次冷启动耗时
    // 超过探活超时，被误报为「安装异常 / ping timeout」（实际安装是成功的）。
    if (!isRuntimeInstalled('faster-whisper')) {
      return {
        state: 'not_installed',
        message: 'faster-whisper runtime not installed',
      };
    }
    const manifest = readEngineManifest('faster-whisper');
    return {
      state: 'ready',
      version: formatInstalledVersion(manifest),
      variant: normalizePyEngineVariant(manifest?.variant),
      parkedVariant: getParkedVariant('faster-whisper') ?? undefined,
    };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeFasterWhisper(ctx);
  },

  cancelActive(): void {
    cancelFasterWhisperTranscription();
  },

  prewarm(formData: Record<string, unknown>): void {
    prewarmFasterWhisper(formData);
  },
};

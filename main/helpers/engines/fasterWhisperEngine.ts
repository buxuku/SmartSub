import fs from 'fs';
import type { EngineStatus, PyEngineManifest } from '../../../types/engine';
import { isRuntimeInstalled, readEngineManifest } from '../pythonRuntime/paths';
import {
  getFasterWhisperModelsPath,
  resolveCt2ModelSnapshotDir,
} from '../modelCatalog';
import { formatSrtContent } from '../fileUtils';
import { logMessage, store } from '../storeManager';
import { getPythonRuntimeManager } from '../pythonRuntime';
import { getTaskContext, TaskCancelledError } from '../taskContext';
import { toFasterWhisperModel } from './modelMap';
import {
  getNumericSetting,
  getWhisperLanguage,
  secondsToSrtTime,
  getFasterWhisperAntiRepetitionParams,
} from './transcribeShared';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

let activeFasterWhisperTranscribeId: string | null = null;

function cancelFasterWhisperTranscription(): void {
  if (activeFasterWhisperTranscribeId) {
    getPythonRuntimeManager().cancel(activeFasterWhisperTranscribeId);
    activeFasterWhisperTranscribeId = null;
  }
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
  const settings = store.get('settings');

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
  const params = {
    engine: 'faster_whisper',
    audio_file: tempAudioFile,
    model: modelSnapshotDir,
    local_files_only: true,
    download_root: getFasterWhisperModelsPath(),
    language: getWhisperLanguage(sourceLanguage),
    device: settings.fasterWhisperDevice || 'auto',
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
    vad_speech_pad_ms: getNumericSetting(settings.vadSpeechPad, 30),
    // 抗幻觉/抗重复参数（仅开关开启时注入；关闭则不下发，sidecar 回落默认）。
    ...getFasterWhisperAntiRepetitionParams(settings),
  };
  logMessage(`fasterWhisperParams: ${JSON.stringify(params, null, 2)}`, 'info');
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const { id, result } = manager.transcribe(params, {
    onProgress: (percent) => {
      event.sender.send('taskProgressChange', file, 'extractSubtitle', percent);
    },
  });
  activeFasterWhisperTranscribeId = id;

  const signal = ctx.signal ?? getTaskContext()?.signal;
  const onAbort = () => {
    if (activeFasterWhisperTranscribeId === id) manager.cancel(id);
  };
  if (signal?.aborted) {
    manager.cancel(id);
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }

  let transcription;
  try {
    transcription = await result;
  } catch (error) {
    // 用户取消：sidecar 回 {code:'cancelled'}。转成取消语义，避免被标记为转写错误。
    if (signal?.aborted || (error as { code?: string })?.code === 'cancelled') {
      throw new TaskCancelledError();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    activeFasterWhisperTranscribeId = null;
  }

  // 边界：转写正常返回但此刻已被取消，同样按取消处理，避免写出半截字幕。
  if (signal?.aborted) {
    throw new TaskCancelledError();
  }

  const formattedSrt = formatSrtContent(
    (transcription?.segments || []).map(
      (segment) =>
        [
          secondsToSrtTime(segment.start),
          secondsToSrtTime(segment.end),
          segment.text || '',
        ] as [string, string, string],
    ),
  );
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
    return { state: 'ready', version: formatInstalledVersion(manifest) };
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

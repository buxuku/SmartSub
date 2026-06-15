import fs from 'fs';
import type { EngineStatus, PyEngineManifest } from '../../../types/engine';
import {
  isPyEngineInstalled,
  readPyEngineManifest,
} from '../pythonRuntime/paths';
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
    engineInfo = await manager.ensureStarted();
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
    vad_speech_pad_ms: getNumericSetting(settings.vadSpeechPad, 30),
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

  async isAvailable(): Promise<EngineStatus> {
    // 安装状态仅以「运行时已落盘 + manifest 存在」为准；运行时探活（冷启动 ping）
    // 推迟到真正转写时进行，避免 PyInstaller 首次冷启动耗时超过探活超时，
    // 被误报为「安装异常 / ping timeout」（实际安装是成功的）。
    if (!isPyEngineInstalled()) {
      return {
        state: 'not_installed',
        message: 'Python engine runtime is not installed',
      };
    }
    const manifest = readPyEngineManifest();
    return { state: 'ready', version: formatInstalledVersion(manifest) };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeFasterWhisper(ctx);
  },

  cancelActive(): void {
    cancelFasterWhisperTranscription();
  },
};

import fs from 'fs';
import path from 'path';
import type { EngineStatus, PyEngineManifest } from '../../../types/engine';
import {
  isPyBaseReady,
  isEnginePackageInstalled,
  readEngineManifest,
} from '../pythonRuntime/paths';
import { getFunasrModelDir, isFunasrReady } from '../funasrModelCatalog';
import { formatSrtContent } from '../fileUtils';
import { logMessage, store } from '../storeManager';
import { getPythonRuntimeManager } from '../pythonRuntime';
import { getTaskContext, TaskCancelledError } from '../taskContext';
import { secondsToSrtTime } from './transcribeShared';
import { buildFunasrParams } from './funasrParams';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

let activeFunasrTranscribeId: string | null = null;

function cancelFunasrTranscription(): void {
  if (activeFunasrTranscribeId) {
    getPythonRuntimeManager().cancel(activeFunasrTranscribeId);
    activeFunasrTranscribeId = null;
  }
}

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
 * 使用 Python sidecar 中的 sherpa-onnx SenseVoice 生成字幕。
 * 取消与 faster-whisper 一致走 AbortSignal：信号触发即通知 sidecar 逐段取消。
 */
async function transcribeFunasr(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', { ...file, extractSubtitle: 'loading' });

  const { tempAudioFile, srtFile } = file;
  const { sourceLanguage } = formData as { sourceLanguage?: string };
  const settings = store.get('settings');

  const manager = getPythonRuntimeManager();
  let engineInfo;
  try {
    engineInfo = await manager.ensureStarted('funasr');
  } catch (error) {
    throw new Error(
      `funasr engine unavailable: ${(error as Error)?.message || error}`,
    );
  }
  if (!engineInfo?.engines?.funasr) {
    throw new Error('funasr is not available in the python engine runtime');
  }
  if (!isFunasrReady()) {
    throw new Error(
      'funasr models not installed. Download SenseVoice + silero-VAD from Resource Hub > Models.',
    );
  }

  const asrDir = getFunasrModelDir('sensevoice-small');
  const params = {
    engine: 'funasr',
    audio_file: tempAudioFile,
    asr_model: path.join(asrDir, 'model.int8.onnx'),
    tokens: path.join(asrDir, 'tokens.txt'),
    vad_model: path.join(getFunasrModelDir('silero-vad'), 'silero_vad.onnx'),
    ...buildFunasrParams(settings, sourceLanguage),
  };
  logMessage(`funasrParams: ${JSON.stringify(params, null, 2)}`, 'info');
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const { id, result } = manager.transcribe(params, {
    onProgress: (percent) =>
      event.sender.send('taskProgressChange', file, 'extractSubtitle', percent),
  });
  activeFunasrTranscribeId = id;

  const signal = ctx.signal ?? getTaskContext()?.signal;
  const onAbort = () => {
    if (activeFunasrTranscribeId === id) manager.cancel(id);
  };
  if (signal?.aborted) manager.cancel(id);
  else signal?.addEventListener('abort', onAbort, { once: true });

  let transcription;
  try {
    transcription = await result;
  } catch (error) {
    if (signal?.aborted || (error as { code?: string })?.code === 'cancelled') {
      throw new TaskCancelledError();
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    activeFunasrTranscribeId = null;
  }

  if (signal?.aborted) throw new TaskCancelledError();

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
    `generate subtitle done (funasr, language=${transcription?.language})`,
    'info',
  );
  return srtFile;
}

export const funasrEngineAdapter: TranscriptionEngineAdapter = {
  id: 'funasr',
  displayName: 'FunASR (SenseVoice)',
  requiresRuntime: true,
  pyEngineId: 'funasr',

  async isAvailable(): Promise<EngineStatus> {
    if (!isPyBaseReady()) {
      return {
        state: 'error',
        message: 'Python base runtime missing; reinstall or update SmartSub',
      };
    }
    if (!isEnginePackageInstalled('funasr')) {
      return {
        state: 'not_installed',
        message: 'funasr engine package not installed',
      };
    }
    // 引擎包在但模型缺：仍报 not_installed（资源中心可下模型），消息区分。
    if (!isFunasrReady()) {
      return {
        state: 'not_installed',
        message: 'funasr models not downloaded',
      };
    }
    const manifest = readEngineManifest('funasr');
    return { state: 'ready', version: formatInstalledVersion(manifest) };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeFunasr(ctx);
  },

  cancelActive(): void {
    cancelFunasrTranscription();
  },
};

import fs from 'fs';
import type { EngineStatus } from '../../../types/engine';
import {
  getParakeetModelFiles,
  getParakeetVadModelPath,
  isParakeetReady,
  getInstalledParakeetModels,
  resolveParakeetSelection,
} from '../parakeetModelCatalog';
import { isSherpaLibInstalled } from '../sherpaOnnx/sherpaLibPaths';
import { getSherpaLibStatus } from '../sherpaOnnx/sherpaLibManager';
import {
  getSherpaAsrRuntime,
  type SherpaModelRequest,
} from '../sherpaOnnx/sherpaFunasrRuntime';
import { formatSrtContent } from '../fileUtils';
import { logMessage, store } from '../storeManager';
import { getTaskContext, TaskCancelledError } from '../taskContext';
import {
  subtitleCueFromSegment,
  trimSubtitleTrailingSilence,
} from '../subtitleTiming';
import { resplitSubtitleCues } from '../subtitleSegmentation';
import { buildParakeetParams } from './parakeetParams';
import { resolveEffectiveSettings } from './outcomePresets';
import type { TranscribeContext, TranscriptionEngineAdapter } from './types';

const activeTranscribeIds = new Set<string>();

type ParakeetSelection = NonNullable<
  ReturnType<typeof resolveParakeetSelection>
>;

function buildModelRequest(
  selection: ParakeetSelection,
  settings: Record<string, unknown>,
): SherpaModelRequest {
  const files = getParakeetModelFiles(selection.id);
  return {
    ...(files.modelType === 'nemo_ctc'
      ? { modelType: files.modelType, asrModel: files.asrModel }
      : {
          modelType: files.modelType,
          transducer: {
            encoder: files.encoder,
            decoder: files.decoder,
            joiner: files.joiner,
          },
        }),
    tokens: files.tokens,
    vadModel: getParakeetVadModelPath(),
    params: buildParakeetParams(settings),
  };
}

function prewarmParakeet(formData: Record<string, unknown>): void {
  try {
    if (!isSherpaLibInstalled() || !isParakeetReady()) return;
    const selection = resolveParakeetSelection(
      (formData as { model?: string })?.model,
      getInstalledParakeetModels(),
    );
    if (!selection) return;
    const settings = resolveEffectiveSettings(
      formData,
      store.get('settings') as Record<string, unknown>,
    );
    getSherpaAsrRuntime().prewarm(buildModelRequest(selection, settings));
    logMessage('parakeet (sherpa) prewarm started', 'info');
  } catch (error) {
    logMessage(`parakeet prewarm error (non-fatal): ${error}`, 'warning');
  }
}

async function transcribeParakeet(ctx: TranscribeContext): Promise<string> {
  const { event, file, formData } = ctx;
  event.sender.send('taskFileChange', {
    ...file,
    extractSubtitle: 'loading',
  });

  const { tempAudioFile, srtFile } = file;
  const settings = resolveEffectiveSettings(
    formData,
    store.get('settings') as Record<string, unknown>,
  );

  if (!isSherpaLibInstalled()) {
    throw new Error(
      'sherpa runtime not installed. Download it from Resource Hub > Engines.',
    );
  }
  if (!isParakeetReady()) {
    throw new Error(
      'Parakeet model or VAD unavailable. Download a model from Engines & Models.',
    );
  }

  const selection = resolveParakeetSelection(
    (formData as { model?: string })?.model,
    getInstalledParakeetModels(),
  );
  if (!selection) {
    throw new Error(
      `Parakeet model unavailable: ${formData.model || '(not selected)'}. Select an installed model in task settings.`,
    );
  }

  const model = buildModelRequest(selection, settings);
  logMessage(`parakeet(sherpa) model: ${JSON.stringify(model)}`, 'info');
  event.sender.send('taskProgressChange', file, 'extractSubtitle', 0);

  const runtime = getSherpaAsrRuntime();
  const { id, result } = runtime.transcribe(model, tempAudioFile, (percent) =>
    event.sender.send('taskProgressChange', file, 'extractSubtitle', percent),
  );
  activeTranscribeIds.add(id);

  const signal = ctx.signal ?? getTaskContext()?.signal;
  const onAbort = () => {
    if (activeTranscribeIds.has(id)) runtime.cancel(id);
  };
  if (signal?.aborted) runtime.cancel(id);
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
    activeTranscribeIds.delete(id);
  }

  if (signal?.aborted) throw new TaskCancelledError();

  ctx.onDiagnostics?.({
    vadAvailable: Array.isArray(transcription?.vadSegments),
    vadSegments: transcription?.vadSegments?.map((segment) => ({
      startMs: Number(segment.start) * 1000,
      endMs: Number(segment.end) * 1000,
    })),
  });

  const subtitles = trimSubtitleTrailingSilence(
    resplitSubtitleCues(
      (transcription?.segments || []).map(subtitleCueFromSegment),
      formData as Record<string, unknown>,
    ),
    tempAudioFile,
  );
  await fs.promises.writeFile(srtFile, formatSrtContent(subtitles));

  event.sender.send('taskProgressChange', file, 'extractSubtitle', 100);
  event.sender.send('taskFileChange', {
    ...file,
    extractSubtitle: 'done',
  });
  logMessage('generate subtitle done (parakeet/sherpa)', 'info');
  return srtFile;
}

export const parakeetEngineAdapter: TranscriptionEngineAdapter = {
  id: 'parakeet',
  displayName: 'NVIDIA Parakeet',
  requiresRuntime: true,

  async isAvailable(): Promise<EngineStatus> {
    if (!isSherpaLibInstalled()) {
      return {
        state: 'not_installed',
        message: 'sherpa runtime not downloaded',
      };
    }
    if (!isParakeetReady()) {
      return {
        state: 'not_installed',
        message: 'parakeet model not downloaded',
      };
    }
    return { state: 'ready', version: getSherpaLibStatus().version };
  },

  async transcribe(ctx: TranscribeContext): Promise<string> {
    return transcribeParakeet(ctx);
  },

  cancelActive(): void {
    const runtime = getSherpaAsrRuntime();
    activeTranscribeIds.forEach((id) => runtime.cancel(id));
    activeTranscribeIds.clear();
  },

  prewarm(formData: Record<string, unknown>): void {
    prewarmParakeet(formData);
  },
};

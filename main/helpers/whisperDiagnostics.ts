import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { app } from 'electron';
import { getModelsInstalled, getPath } from './whisper';
import { getAddonVersionDir, isAddonInstalled } from './addonManager';
import { getBuiltinVulkanAddonPath } from './cudaUtils';
import { getExtraResourcesPath, sanitizeLogMessage } from './utils';
import { store, logMessage } from './storeManager';
import { getVadSettings } from './engines/transcribeShared';
import { createPathRedactor } from './crash/crashEvents';
import { withCrashContext } from './crash/crashContext';
import { spawnAppUtilityHost } from './crash/appUtilityHost';
import { runWhisperProbe } from './crash/whisperProbe';
import type {
  WhisperProbeOptions,
  WhisperProbeRequest,
  WhisperProbeResult,
} from '../../types/whisperProbe';

let active: AbortController | null = null;

function candidates() {
  const vulkanDownloaded = isAddonInstalled('vulkan');
  return {
    vulkan: {
      path: vulkanDownloaded
        ? path.join(getAddonVersionDir('vulkan'), 'addon.node')
        : getBuiltinVulkanAddonPath(),
      source: vulkanDownloaded ? 'userData' : 'builtin',
    },
    cpu: {
      path: path.join(getExtraResourcesPath(), 'addons', 'addon.node'),
      source: 'builtin',
    },
  };
}

export function getWhisperProbeOptions(): WhisperProbeOptions | undefined {
  if (process.platform !== 'win32' && process.platform !== 'linux')
    return undefined;
  const available = candidates();
  const models = getModelsInstalled().sort();
  const last = store.get('settings')?.lastUsedTranscription;
  return {
    models,
    defaultModel:
      last?.engine === 'builtin' && models.includes(last.model)
        ? last.model
        : models.includes('tiny')
          ? 'tiny'
          : (models[0] ?? ''),
    backends: (['vulkan', 'cpu'] as const).filter((key) =>
      fs.existsSync(available[key].path),
    ),
    vad: store.get('settings')?.useVAD !== false,
  };
}

/** Decode the bundled speech sample via argv; PCM also avoids native Windows path limits. */
function samplePcm(signal: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegStatic.replace('app.asar', 'app.asar.unpacked'),
      [
        '-nostdin',
        '-v',
        'error',
        '-i',
        path.join(getExtraResourcesPath(), 'sample-onboarding.mp3'),
        '-t',
        '12',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-f',
        'f32le',
        'pipe:1',
      ],
      {
        encoding: 'buffer',
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        if (!stdout.length || stdout.length % 4) {
          reject(new Error('Invalid diagnostic sample PCM'));
          return;
        }
        const pcm = new Float32Array(stdout.length / 4);
        for (let i = 0; i < pcm.length; i++) pcm[i] = stdout.readFloatLE(i * 4);
        resolve(pcm);
      },
    );
  });
}

export function cancelWhisperDiagnostic(): void {
  active?.abort();
}

export async function runWhisperDiagnostic(
  request: WhisperProbeRequest,
): Promise<WhisperProbeResult> {
  if (active) throw new Error('A whisper diagnostic is already running');
  const options = getWhisperProbeOptions();
  if (
    !request ||
    !options?.models.includes(request.model) ||
    !options.backends.includes(request.backend) ||
    typeof request.vad !== 'boolean'
  ) {
    throw new Error(
      'Select an installed whisper model and an available diagnostic backend',
    );
  }
  // Only persist the explicit diagnostic fields supplied by the UI.
  request = {
    model: request.model,
    backend: request.backend,
    vad: request.vad,
  };
  const addon = candidates()[request.backend];
  const redact = createPathRedactor([os.homedir(), app.getPath('userData')]);
  const clean = (text: string) => redact(sanitizeLogMessage(text));
  const controller = new AbortController();
  active = controller;
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 180_000);
  const save = (report: WhisperProbeResult) => {
    report.startedAt = startedAt;
    report.durationMs = Date.now() - startedAt;
    if (timedOut) report.status = 'timeout';
    store.set(
      'whisperProbeHistory',
      [...(store.get('whisperProbeHistory') ?? []), report].slice(-6),
    );
    logMessage(
      `Whisper diagnostic finished: ${request.backend}/${request.model}, ${report.status} (${report.phase})`,
      'info',
    );
    return report;
  };
  try {
    const pcmf32 = await samplePcm(controller.signal);
    logMessage(
      `Whisper diagnostic: ${JSON.stringify({ ...request, addon })}`,
      'info',
    );
    const vad = getVadSettings(
      store.get('settings') as Record<string, unknown>,
    );
    const report = await withCrashContext(
      {
        engine: 'whisper-diagnostic',
        backend: request.backend,
        model: request.model,
        phase: 'probe',
      },
      () =>
        runWhisperProbe({
          request,
          addonPath: addon.path,
          addonSource: addon.source,
          signal: controller.signal,
          clean,
          params: {
            model: path.join(
              getPath('modelsPath'),
              `ggml-${request.model}.bin`,
            ),
            fname_inp: '',
            pcmf32,
            language: 'en',
            use_gpu: request.backend === 'vulkan',
            flash_attn: false,
            no_prints: false,
            translate: false,
            token_timestamps: true,
            no_timestamps: false,
            max_len: 0,
            audio_ctx: 0,
            max_context: -1,
            print_progress: true,
            vad: request.vad,
            vad_model: path.join(
              getExtraResourcesPath(),
              'ggml-silero-v6.2.0.bin',
            ),
            vad_threshold: vad.vadThreshold,
            vad_min_speech_duration_ms: vad.vadMinSpeechDuration,
            vad_min_silence_duration_ms: vad.vadMinSilenceDuration,
            vad_max_speech_duration_s: vad.vadMaxSpeechDuration,
            vad_speech_pad_ms: vad.vadSpeechPad,
            vad_samples_overlap: vad.vadSamplesOverlap,
          },
          spawn: (onStderrLine) =>
            spawnAppUtilityHost({
              workerFile: path.join(
                getExtraResourcesPath(),
                'diagnostics',
                'whisper-probe.cjs',
              ),
              serviceName: 'smartsub-whisper-diagnostic',
              logLabel: 'whisper diagnostic',
              onStderrLine,
              env: {
                ...process.env,
                PATH: `${path.dirname(addon.path)}${path.delimiter}${process.env.PATH ?? ''}`,
                LD_LIBRARY_PATH: `${path.dirname(addon.path)}${path.delimiter}${process.env.LD_LIBRARY_PATH ?? ''}`,
              },
            }),
        }),
    );
    return save(report);
  } catch (error) {
    return save({
      ...request,
      startedAt,
      durationMs: Date.now() - startedAt,
      addonPath: clean(addon.path),
      addonSource: addon.source,
      flashAttn: false,
      input: 'bundled-sample',
      phase: 'preparing',
      status: controller.signal.aborted ? 'cancelled' : 'error',
      error: clean(error instanceof Error ? error.message : String(error)),
      nativeDeviceLines: [],
      stderrTail: '',
    });
  } finally {
    clearTimeout(timer);
    active = null;
  }
}

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  TtsProvider,
  TtsSegmentRequest,
} from '../../../types/ttsProvider';
import {
  atempoWav,
  readWavInfo,
  transcodeToPcm16Wav,
} from '../../helpers/dubbing/audioPipeline';
import { TaskCancelledError } from '../../helpers/taskContext';
import {
  buildXiaomiMimoHeaders,
  positiveNumber,
  readXiaomiMimoError,
  xiaomiMimoChatURL,
} from '../xiaomiMimoUtils';
import type { TtsSynthesizeResult } from './types';
import {
  buildXiaomiMimoTtsBody,
  parseXiaomiMimoTtsResponse,
} from './xiaomiMimoUtils';

const DEFAULT_TIMEOUT_SEC = 60;

function cleanup(paths: string[]): void {
  for (const file of paths) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // Best-effort cleanup of provider intermediates.
    }
  }
}

export async function synthesizeWithXiaomiMimo(
  provider: TtsProvider,
  request: TtsSegmentRequest,
): Promise<TtsSynthesizeResult> {
  const apiKey = String(provider.apiKey ?? '').trim();
  if (!apiKey) throw new Error('Xiaomi MiMo TTS: API key is required');
  if (!request.voice.trim())
    throw new Error('Xiaomi MiMo TTS: voice is required');

  const timeoutMs =
    positiveNumber(provider.requestTimeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (request.signal) signals.push(request.signal);

  try {
    const res = await fetch(xiaomiMimoChatURL(provider.apiUrl), {
      method: 'POST',
      headers: buildXiaomiMimoHeaders(apiKey),
      body: JSON.stringify(
        buildXiaomiMimoTtsBody({
          text: request.text,
          voice: request.voice,
        }),
      ),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) {
      const detail = await readXiaomiMimoError(res);
      throw new Error(
        `Xiaomi MiMo TTS: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`,
      );
    }

    const audio = parseXiaomiMimoTtsResponse(await res.json());
    const suffix = randomUUID();
    const sourcePath = `${request.outWavPath}.mimo-${suffix}.wav`;
    const normalizedPath = `${request.outWavPath}.mimo-${suffix}-pcm.wav`;
    fs.mkdirSync(path.dirname(request.outWavPath), { recursive: true });
    fs.writeFileSync(sourcePath, audio);
    try {
      readWavInfo(sourcePath);
      const speed =
        Number.isFinite(Number(request.speed)) && Number(request.speed) > 0
          ? Number(request.speed)
          : 1;
      if (Math.abs(speed - 1) < 1e-3) {
        await transcodeToPcm16Wav(sourcePath, request.outWavPath, {
          sampleRate: 24000,
          signal: request.signal,
        });
      } else {
        await transcodeToPcm16Wav(sourcePath, normalizedPath, {
          sampleRate: 24000,
          signal: request.signal,
        });
        await atempoWav(
          normalizedPath,
          request.outWavPath,
          speed,
          request.signal,
        );
      }
    } finally {
      cleanup([sourcePath, normalizedPath]);
    }

    return {
      wavPath: request.outWavPath,
      durationMs: readWavInfo(request.outWavPath).durationMs,
    };
  } catch (error) {
    if (request.signal?.aborted) throw new TaskCancelledError();
    throw error;
  }
}

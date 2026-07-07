import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import type { TtsProvider } from '../../../types/ttsProvider';
import {
  throwIfSignalCancelled,
  TaskCancelledError,
} from '../../helpers/taskContext';
import { logMessage } from '../../helpers/storeManager';
import { getTempDir } from '../../helpers/fileUtils';
import { normalizeBaseURL } from '../asr/openaiCompatUtils';
import type { TtsSynthesizeInput } from './types';

const DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_MAX_RETRIES = 2;

function toPositiveNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function runFfmpegToWav(inPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .audioCodec('pcm_s16le')
      .outputOptions('-y')
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outPath);
  });
}

/**
 * OpenAI 兼容 `/v1/audio/speech` 合成；优先 wav，mp3 兜底经 ffmpeg 转 wav。
 */
export async function synthesizeWithOpenAiCompatibleTts(
  provider: TtsProvider,
  input: TtsSynthesizeInput,
): Promise<void> {
  const apiKey = String(provider?.apiKey ?? '').trim();
  if (!apiKey) throw new Error('Cloud TTS: API key is required');
  const model = String(provider?.model ?? '').trim();
  const voice = String(provider?.voice ?? '').trim();
  if (!model || !voice) {
    throw new Error('Cloud TTS: model and voice are required');
  }

  const baseURL = normalizeBaseURL(provider.apiUrl);
  const timeoutMs =
    toPositiveNumber(provider.requestTimeoutSec, DEFAULT_TIMEOUT_SEC) * 1000;
  const maxRetries = Math.max(
    0,
    Math.floor(toPositiveNumber(provider.maxRetries, DEFAULT_MAX_RETRIES)),
  );
  const format = String(provider.responseFormat || 'wav').toLowerCase() as
    | 'wav'
    | 'mp3';

  const client = new OpenAI({
    baseURL,
    apiKey,
    timeout: timeoutMs,
    maxRetries,
  });

  throwIfSignalCancelled(input.signal);
  const response = await client.audio.speech.create(
    {
      model,
      voice,
      input: input.text,
      response_format: format,
    } as never,
    { signal: input.signal },
  );

  throwIfSignalCancelled(input.signal);
  const buf = Buffer.from(await response.arrayBuffer());
  const dir = path.dirname(input.outWavPath);
  fs.mkdirSync(dir, { recursive: true });

  if (format === 'wav') {
    fs.writeFileSync(input.outWavPath, buf);
    return;
  }

  const tmpMp3 = input.outWavPath.replace(/\.wav$/i, '.cloud.mp3');
  try {
    fs.writeFileSync(tmpMp3, buf);
    await runFfmpegToWav(tmpMp3, input.outWavPath);
  } finally {
    try {
      if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3);
    } catch {
      /* ignore */
    }
  }
}

export async function testOpenAiCompatibleTts(
  provider: TtsProvider,
): Promise<import('./types').TtsTestResult> {
  const apiKey = String(provider?.apiKey ?? '').trim();
  const model = String(provider?.model ?? '').trim();
  const voice = String(provider?.voice ?? '').trim();
  if (!apiKey || !model || !voice) {
    return { ok: false, needsConfig: true };
  }
  const tmpDir = path.join(getTempDir(), 'tts-test');
  fs.mkdirSync(tmpDir, { recursive: true });
  const outWav = path.join(tmpDir, `test-${Date.now()}.wav`);
  try {
    await synthesizeWithOpenAiCompatibleTts(provider, {
      text: 'Hello',
      outWavPath: outWav,
    });
    return { ok: fs.existsSync(outWav) && fs.statSync(outWav).size > 44 };
  } catch (error) {
    if (error instanceof TaskCancelledError) throw error;
    logMessage(`cloud TTS test failed: ${error}`, 'warning');
    return { ok: false, detail: String((error as Error)?.message || error) };
  } finally {
    try {
      if (fs.existsSync(outWav)) fs.unlinkSync(outWav);
    } catch {
      /* ignore */
    }
  }
}

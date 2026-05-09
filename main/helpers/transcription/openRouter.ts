import axios from 'axios';
import { execFile } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs-extra';
import path from 'path';
import { promisify } from 'util';
import { ensureTempDir, getMd5 } from '../fileUtils';
import { logMessage, store } from '../storeManager';
import {
  OPENROUTER_GPT4O_TRANSCRIBE_MODEL,
  type TranscriptionSegment,
  type TranscriptionResult,
} from '../../../types';
import {
  getAudioDurationSeconds,
  makeApproximateSegments,
  type SpeechWindow,
} from './srt';

const execFileAsync = promisify(execFile);

export const OPENROUTER_TRANSCRIPTION_ENDPOINT =
  'https://openrouter.ai/api/v1/audio/transcriptions';
export const OPENROUTER_TRANSCRIPTION_MODELS_ENDPOINT =
  'https://openrouter.ai/api/v1/models?output_modalities=transcription';
export const OPENROUTER_STT_MAX_CHUNK_SECONDS = 30;
export const OPENROUTER_STT_MIN_CHUNK_SECONDS = 8;
export const OPENROUTER_STT_AUDIO_BITRATE = '64k';
export const OPENROUTER_STT_SILENCE_DB = '-35dB';
export const OPENROUTER_STT_MIN_SILENCE_SECONDS = 0.45;

const DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL: typeof OPENROUTER_GPT4O_TRANSCRIBE_MODEL =
  'openai/gpt-4o-transcribe';
const DEFAULT_OPENROUTER_APP_NAME = 'SmartSub';

interface OpenRouterAudioChunk {
  path: string;
  offsetSeconds: number;
  durationSeconds: number;
  speechWindows: SpeechWindow[];
  temporaryDir: string;
}

interface SilenceInterval {
  start: number;
  end: number;
}

interface OpenRouterChunkPlan {
  start: number;
  end: number;
  speechWindows: SpeechWindow[];
}

function normalizeOpenRouterBaseUrl(baseUrl?: string): string {
  const normalized = (baseUrl || 'https://openrouter.ai/api/v1').replace(
    /\/+$/,
    '',
  );
  const audioPath = '/audio/transcriptions';
  const chatPath = '/chat/completions';
  if (normalized.endsWith(chatPath)) {
    return `${normalized.slice(0, -chatPath.length)}${audioPath}`;
  }
  return normalized.endsWith(audioPath)
    ? normalized
    : `${normalized}${audioPath}`;
}

function normalizeOpenRouterModelsUrl(baseUrl?: string): string {
  const normalized = (baseUrl || 'https://openrouter.ai/api/v1').replace(
    /\/+$/,
    '',
  );
  if (normalized.includes('/models')) return normalized;

  const audioPath = '/audio/transcriptions';
  const chatPath = '/chat/completions';
  const apiBase = normalized.endsWith(audioPath)
    ? normalized.slice(0, -audioPath.length)
    : normalized.endsWith(chatPath)
      ? normalized.slice(0, -chatPath.length)
      : normalized;
  return `${apiBase}/models?output_modalities=transcription`;
}

function getAudioFormat(audioPath: string): string {
  const ext = path.extname(audioPath).replace('.', '').toLowerCase();
  return ext || 'wav';
}

function cleanHeaderValue(value?: string): string | undefined {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed : undefined;
}

function buildOpenRouterHeaders(
  apiKey: string,
  settings: Record<string, any>,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title':
      cleanHeaderValue(settings.openRouterAppName) ||
      DEFAULT_OPENROUTER_APP_NAME,
  };

  const referer = cleanHeaderValue(settings.openRouterSiteUrl);
  if (referer) {
    headers['HTTP-Referer'] = referer;
  }

  return headers;
}

export function redactOpenRouterSecrets(input: string): string {
  return input
    .replace(/sk-or-v1-[A-Za-z0-9._-]+/gi, 'sk-or-v1-[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(
      /("(?:api_?key|authorization|token|access_token|refresh_token)"\s*:\s*")([^"]+)(")/gi,
      '$1[REDACTED]$3',
    )
    .replace(
      /((?:api_?key|authorization|token|access_token|refresh_token)\s*[=:]\s*)([^,\s]+)/gi,
      '$1[REDACTED]',
    );
}

function compactErrorBody(value: unknown): string {
  if (!value) return '';
  const raw =
    typeof value === 'string' ? value : JSON.stringify(value, null, 0);
  const compact = redactOpenRouterSecrets(raw).replace(/\s+/g, ' ').trim();
  return compact.length > 360 ? `${compact.slice(0, 360)}...` : compact;
}

function getOpenRouterErrorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const status = error.response?.status;
  const generationId =
    error.response?.headers?.['x-generation-id'] ||
    error.response?.headers?.['X-Generation-Id'];
  const body = compactErrorBody(error.response?.data);
  const details = [
    status ? `HTTP ${status}` : undefined,
    body,
    generationId ? `X-Generation-Id: ${generationId}` : undefined,
  ].filter(Boolean);

  return details.length
    ? `OpenRouter 转录失败：${details.join(' | ')}`
    : `OpenRouter 转录失败：${error.message}`;
}

function throwIfOpenRouterCancelled(isCancellationRequested?: () => boolean) {
  if (isCancellationRequested?.()) {
    throw new Error('任务已取消');
  }
}

function parseSilenceDetectOutput(output: string, duration: number) {
  const silences: SilenceInterval[] = [];
  let pendingStart: number | null = null;

  for (const line of output.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
    if (endMatch && pendingStart !== null) {
      const start = Math.max(0, pendingStart);
      const end = Math.min(duration, Number(endMatch[1]));
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        silences.push({ start, end });
      }
      pendingStart = null;
    }
  }

  if (pendingStart !== null && duration > pendingStart) {
    silences.push({ start: pendingStart, end: duration });
  }

  return silences;
}

async function detectSilenceIntervals(
  audioPath: string,
  duration: number,
): Promise<SilenceInterval[]> {
  if (duration <= OPENROUTER_STT_MIN_CHUNK_SECONDS) return [];

  const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
  try {
    const { stdout, stderr } = await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostats',
        '-i',
        audioPath,
        '-af',
        `silencedetect=noise=${OPENROUTER_STT_SILENCE_DB}:d=${OPENROUTER_STT_MIN_SILENCE_SECONDS}`,
        '-f',
        'null',
        '-',
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    return parseSilenceDetectOutput(`${stdout}\n${stderr}`, duration);
  } catch (error: any) {
    const output = `${error?.stdout || ''}\n${error?.stderr || ''}`;
    const parsed = parseSilenceDetectOutput(output, duration);
    if (parsed.length > 0) return parsed;
    logMessage(
      `OpenRouter silence detection skipped: ${error?.message || String(error)}`,
      'warning',
    );
    return [];
  }
}

function getSpeechWindowsForChunk(
  chunkStart: number,
  chunkEnd: number,
  silences: SilenceInterval[],
): SpeechWindow[] {
  const windows: SpeechWindow[] = [];
  let cursor = chunkStart;

  for (const silence of silences) {
    if (silence.end <= chunkStart || silence.start >= chunkEnd) continue;

    const silenceStart = Math.max(chunkStart, silence.start);
    const silenceEnd = Math.min(chunkEnd, silence.end);

    if (silenceStart - cursor >= 0.25) {
      windows.push({
        start: cursor - chunkStart,
        end: silenceStart - chunkStart,
      });
    }
    cursor = Math.max(cursor, silenceEnd);
  }

  if (chunkEnd - cursor >= 0.25) {
    windows.push({
      start: cursor - chunkStart,
      end: chunkEnd - chunkStart,
    });
  }

  return windows.length > 0
    ? windows
    : [{ start: 0, end: Math.max(0.5, chunkEnd - chunkStart) }];
}

function buildSilenceAwareChunkPlans(
  duration: number,
  silences: SilenceInterval[],
): OpenRouterChunkPlan[] {
  if (duration <= 0) {
    return [
      {
        start: 0,
        end: OPENROUTER_STT_MAX_CHUNK_SECONDS,
        speechWindows: [{ start: 0, end: OPENROUTER_STT_MAX_CHUNK_SECONDS }],
      },
    ];
  }

  const plans: OpenRouterChunkPlan[] = [];
  let cursor = 0;

  while (cursor < duration - 0.25) {
    const hardEnd = Math.min(
      duration,
      cursor + OPENROUTER_STT_MAX_CHUNK_SECONDS,
    );
    let chunkEnd = hardEnd;
    let nextCursor = hardEnd;

    if (hardEnd < duration) {
      const earliestSplit = cursor + OPENROUTER_STT_MIN_CHUNK_SECONDS;
      const candidates = silences.filter(
        (silence) =>
          silence.start >= earliestSplit &&
          silence.start <= hardEnd &&
          silence.end > silence.start,
      );
      const bestSilence = candidates[candidates.length - 1];
      if (bestSilence) {
        chunkEnd = Math.max(cursor + 0.5, bestSilence.start);
        nextCursor = Math.max(chunkEnd, bestSilence.end);
      }
    }

    if (duration - nextCursor < 1.5) {
      chunkEnd = duration;
      nextCursor = duration;
    }

    plans.push({
      start: cursor,
      end: chunkEnd,
      speechWindows: getSpeechWindowsForChunk(cursor, chunkEnd, silences),
    });
    cursor = nextCursor;
  }

  return plans;
}

async function splitAudioForOpenRouter(
  audioPath: string,
): Promise<OpenRouterAudioChunk[]> {
  const ffmpegPath = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
  const chunkDir = path.join(
    ensureTempDir(),
    `openrouter-${getMd5(audioPath)}`,
  );
  await fs.emptyDir(chunkDir);

  const sourceDuration = await getAudioDurationSeconds(audioPath);
  const silenceIntervals = await detectSilenceIntervals(
    audioPath,
    sourceDuration,
  );
  const chunkPlans = buildSilenceAwareChunkPlans(
    sourceDuration,
    silenceIntervals,
  );

  const chunks: OpenRouterAudioChunk[] = [];
  for (let index = 0; index < chunkPlans.length; index++) {
    const plan = chunkPlans[index];
    const chunkPath = path.join(
      chunkDir,
      `chunk-${String(index).padStart(5, '0')}.mp3`,
    );

    try {
      await execFileAsync(ffmpegPath, [
        '-y',
        '-ss',
        String(plan.start),
        '-t',
        String(Math.max(0.5, plan.end - plan.start)),
        '-i',
        audioPath,
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-b:a',
        OPENROUTER_STT_AUDIO_BITRATE,
        chunkPath,
      ]);
    } catch (error: any) {
      await fs.remove(chunkDir);
      throw new Error(
        `OpenRouter 音频分片失败：${error?.message || String(error)}`,
      );
    }

    const measuredDuration = await getAudioDurationSeconds(chunkPath);
    const durationSeconds =
      measuredDuration || Math.max(0.5, plan.end - plan.start);

    chunks.push({
      path: chunkPath,
      offsetSeconds: plan.start,
      durationSeconds,
      speechWindows: plan.speechWindows,
      temporaryDir: chunkDir,
    });
  }

  return chunks;
}

async function removeOpenRouterChunks(chunks: OpenRouterAudioChunk[]) {
  const dirs = new Set(chunks.map((chunk) => chunk.temporaryDir));
  const dirsToRemove: string[] = [];
  dirs.forEach((dir) => dirsToRemove.push(dir));
  await Promise.all(dirsToRemove.map((dir) => fs.remove(dir)));
}

async function transcribeOpenRouterChunk({
  chunk,
  endpoint,
  model,
  headers,
  language,
}: {
  chunk: OpenRouterAudioChunk;
  endpoint: string;
  model: string;
  headers: Record<string, string>;
  language?: string;
}): Promise<string> {
  const audioBuffer = await fs.readFile(chunk.path);
  const requestBody: Record<string, any> = {
    model,
    input_audio: {
      data: audioBuffer.toString('base64'),
      format: getAudioFormat(chunk.path),
    },
    temperature: 0,
  };

  if (language) {
    requestBody.language = language;
  }

  const response = await axios.post(endpoint, requestBody, {
    headers,
    timeout: 10 * 60 * 1000,
  });

  const text = extractOpenRouterTranscriptText(response?.data);
  if (!text) {
    throw new Error('OpenRouter 转录返回为空');
  }
  return text;
}

function extractOpenRouterTranscriptText(data: any): string {
  if (!data) return '';
  if (typeof data.text === 'string') return data.text.trim();

  const messageContent = data.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string') return messageContent.trim();
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .join('')
      .trim();
  }

  return '';
}

export async function fetchOpenRouterTranscriptionModels(): Promise<string[]> {
  const settings = (store.get('settings') || {}) as Record<string, any>;
  const apiKey = settings.openRouterApiKey;

  if (!apiKey) {
    throw new Error('请先在设置中配置 OpenRouter API Key');
  }

  let response;
  try {
    response = await axios.get(
      normalizeOpenRouterModelsUrl(settings.openRouterBaseUrl),
      {
        headers: buildOpenRouterHeaders(apiKey, settings),
        timeout: 30 * 1000,
      },
    );
  } catch (error) {
    throw new Error(getOpenRouterErrorMessage(error));
  }

  return (response?.data?.data || [])
    .filter((model: any) => {
      const rawInputModalities = model?.architecture?.input_modalities;
      const rawOutputModalities = model?.architecture?.output_modalities;
      const inputModalities = Array.isArray(rawInputModalities)
        ? rawInputModalities
        : [];
      const outputModalities = Array.isArray(rawOutputModalities)
        ? rawOutputModalities
        : [];
      const id = String(model?.id || '');
      return (
        outputModalities.includes('transcription') ||
        inputModalities.includes('audio') ||
        id.toLowerCase().includes('whisper') ||
        id.toLowerCase().includes('transcribe')
      );
    })
    .map((model: { id?: string }) => model.id)
    .filter((model: string | undefined): model is string => Boolean(model));
}

export async function transcribeWithOpenRouter(
  audioPath: string,
  formData: Record<string, any>,
  onProgress?: (progress: number) => void,
  isCancellationRequested?: () => boolean,
): Promise<TranscriptionResult> {
  const settings = (store.get('settings') || {}) as Record<string, any>;
  const apiKey = settings.openRouterApiKey;

  if (!apiKey) {
    throw new Error('请先在设置中配置 OpenRouter API Key');
  }

  const endpoint = normalizeOpenRouterBaseUrl(
    settings.openRouterBaseUrl || OPENROUTER_TRANSCRIPTION_ENDPOINT,
  );
  const model =
    formData.model ||
    settings.openRouterTranscriptionModel ||
    DEFAULT_OPENROUTER_TRANSCRIPTION_MODEL;
  const language =
    formData.sourceLanguage === 'auto' ? undefined : formData.sourceLanguage;

  logMessage(`OpenRouter transcription started with model: ${model}`, 'info');
  throwIfOpenRouterCancelled(isCancellationRequested);
  onProgress?.(5);

  const chunks = await splitAudioForOpenRouter(audioPath);
  throwIfOpenRouterCancelled(isCancellationRequested);
  onProgress?.(10);
  const headers = buildOpenRouterHeaders(apiKey, settings);
  const texts: string[] = [];
  const segments: TranscriptionSegment[] = [];

  try {
    for (let index = 0; index < chunks.length; index++) {
      throwIfOpenRouterCancelled(isCancellationRequested);
      const chunk = chunks[index];
      logMessage(
        `OpenRouter transcription chunk ${index + 1}/${chunks.length}`,
        'info',
      );
      const text = await transcribeOpenRouterChunk({
        chunk,
        endpoint,
        model,
        headers,
        language,
      });
      texts.push(text);
      throwIfOpenRouterCancelled(isCancellationRequested);
      segments.push(
        ...makeApproximateSegments(
          text,
          chunk.durationSeconds,
          chunk.speechWindows,
        ).map((segment) => ({
          ...segment,
          start: segment.start + chunk.offsetSeconds,
          end: segment.end + chunk.offsetSeconds,
        })),
      );
      onProgress?.(Math.round(((index + 1) / chunks.length) * 85 + 10));
    }
  } catch (error) {
    if (error instanceof Error && error.message === '任务已取消') {
      throw error;
    }
    throw new Error(getOpenRouterErrorMessage(error));
  } finally {
    await removeOpenRouterChunks(chunks);
  }

  const text = texts.join('\n').trim();
  if (!text) {
    throw new Error('OpenRouter 转录返回为空');
  }

  return { text, segments };
}

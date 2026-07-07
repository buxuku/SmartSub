import fs from 'fs';
import path from 'path';
import type {
  TtsProvider,
  TtsSegmentRequest,
} from '../../../types/ttsProvider';
import type { TtsSynthesizeResult } from './types';
import {
  transcodeToPcm16Wav,
  readWavInfo,
} from '../../helpers/dubbing/audioPipeline';

/** 规范化 Base URL：http(s) 必须；去误粘的 /audio/speech 后缀；去尾斜杠。 */
export function normalizeTtsBaseURL(apiUrl?: string): string {
  const trimmed = apiUrl?.trim();
  if (!trimmed) throw new Error('Cloud TTS: API base URL is required');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      'Cloud TTS: API base URL must start with http:// or https://',
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(
      'Cloud TTS: API base URL must start with http:// or https://',
    );
  }
  let normalizedPath = parsed.pathname.replace(/\/+$/, '');
  normalizedPath = normalizedPath.replace(/\/audio\/speech$/i, '');
  parsed.pathname = normalizedPath || '/';
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

/** OpenAI speed 合法区间 0.25–4.0；无效值回落 1。 */
export function clampOpenAiSpeed(speed: number | undefined): number {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(4, Math.max(0.25, s));
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function readErrorDetail(res: Response): Promise<string> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return '';
  }
  try {
    const j = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    if (j?.error?.message) return String(j.error.message);
    if (j?.message) return String(j.message);
  } catch {
    /* 非 JSON */
  }
  return text.slice(0, 200);
}

const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');

/**
 * OpenAI 兼容 /audio/speech 合成：请求 wav 直出；端点若忽略 response_format
 * 返回 mp3 等格式，按字节头嗅探后经 ffmpeg 统一转 16-bit PCM 单声道 wav。
 */
export async function synthesizeWithOpenAiCompatible(
  provider: TtsProvider,
  request: TtsSegmentRequest,
): Promise<TtsSynthesizeResult> {
  const base = normalizeTtsBaseURL(provider.apiUrl);
  const apiKey = String(provider.apiKey ?? '').trim();
  if (!apiKey) throw new Error('Cloud TTS: API key is required');
  const model = String(provider.model ?? 'tts-1').trim() || 'tts-1';
  const timeoutMs = toPositiveNumber(provider.requestTimeoutSec, 60) * 1000;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (request.signal) signals.push(request.signal);

  const res = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: request.text,
      voice: request.voice,
      speed: clampOpenAiSpeed(request.speed),
      response_format: 'wav',
    }),
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(
      `Cloud TTS: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`,
    );
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('Cloud TTS: empty audio response');

  if (audio.subarray(0, 4).equals(RIFF_MAGIC)) {
    // 已是 wav：仍统一转 16-bit PCM 单声道（部分端点返回 float/多声道 wav）。
    const info = tryReadWav(audio, request.outWavPath);
    if (info) {
      return { wavPath: request.outWavPath, durationMs: info };
    }
  }
  // 非 wav（mp3/opus 等）或非标准 wav：临时落盘 → ffmpeg 转码。
  const tmp = `${request.outWavPath}.src-${Date.now()}`;
  fs.writeFileSync(tmp, audio);
  try {
    await transcodeToPcm16Wav(tmp, request.outWavPath, {
      signal: request.signal,
    });
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  return {
    wavPath: request.outWavPath,
    durationMs: readWavInfo(request.outWavPath).durationMs,
  };
}

/** 若响应是规范 16-bit PCM 单声道 wav 就直接落盘，返回时长；否则 null 走转码。 */
function tryReadWav(audio: Buffer, outPath: string): number | null {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, audio);
  try {
    const info = readWavInfo(outPath);
    if (info.bitsPerSample === 16 && info.channels === 1) {
      return info.durationMs;
    }
  } catch {
    /* 非标准 wav → 转码 */
  }
  return null;
}

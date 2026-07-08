import type {
  TtsProvider,
  TtsSegmentRequest,
} from '../../../types/ttsProvider';
import type { TtsSynthesizeResult } from './types';
import { TaskCancelledError } from '../../helpers/taskContext';
import { writePcmAsWav } from '../../helpers/dubbing/audioPipeline';
import {
  ELEVENLABS_PCM_SAMPLE_RATE,
  buildElevenLabsBody,
  buildElevenLabsTtsURL,
  buildElevenLabsVoicesURL,
  mapElevenLabsVoices,
  normalizeElevenLabsTtsBaseURL,
} from './elevenlabsTtsUtils';

/**
 * ElevenLabs TTS（REST text-to-speech/{voiceId}，xi-api-key）。
 *
 * - `output_format=pcm_24000` 直出裸 PCM，本地拼 WAV 头零 ffmpeg 转码；
 * - speedControl='native'：voice_settings.speed（provider 内 clamp [0.7,1.2]，
 *   超出部分由对齐引擎云端 atempo 复测分支补足）；
 * - 国内无法直连：网络类失败附代理引导文案。
 */

/** 网络不可达类错误的引导文案（拼在原始错误后，UI 直接展示）。 */
const ELEVEN_NETWORK_HINT =
  'ElevenLabs 国内无法直连，请配置系统网络代理后重试，或切换其它配音服务商。';

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
    // ElevenLabs 错误形态：{ detail: { status, message } } 或 { detail: '...' }
    const j = JSON.parse(text) as {
      detail?: { message?: unknown } | string;
    };
    if (typeof j?.detail === 'string') return j.detail;
    if (j?.detail?.message) return String(j.detail.message);
  } catch {
    /* 非 JSON */
  }
  return text.slice(0, 200);
}

export async function synthesizeWithElevenLabs(
  provider: TtsProvider,
  request: TtsSegmentRequest,
): Promise<TtsSynthesizeResult> {
  const apiKey = String(provider.apiKey ?? '').trim();
  if (!apiKey) throw new Error('ElevenLabs TTS: API key is required');
  const model = String(provider.model ?? '').trim() || 'eleven_multilingual_v2';
  const base = normalizeElevenLabsTtsBaseURL(provider.apiUrl);
  const url = buildElevenLabsTtsURL(base, request.voice);
  const timeoutMs = toPositiveNumber(provider.requestTimeoutSec, 60) * 1000;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (request.signal) signals.push(request.signal);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(
        buildElevenLabsBody(request.text, model, request.speed),
      ),
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    if (request.signal?.aborted) throw new TaskCancelledError();
    const msg = e instanceof Error ? e.message : String(e);
    // 超时（AbortSignal.timeout）与连接失败统一按网络类引导。
    throw new Error(
      `ElevenLabs TTS: 请求失败（${msg}）。${ELEVEN_NETWORK_HINT}`,
    );
  }
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    if (res.status === 401) {
      // 受限权限 Key（missing_permissions）与无效 Key 分开引导。
      const hint = /missing the permission/i.test(detail)
        ? '该 Key 为受限权限 Key：请到 ElevenLabs dashboard ▸ API Keys 编辑此 Key，勾选 Text to Speech 权限（或改用不受限的 Key）'
        : '请检查 xi-api-key 是否有效';
      throw new Error(
        `ElevenLabs TTS: HTTP 401${detail ? ` - ${detail}` : ''}。${hint}`,
      );
    }
    if (res.status === 402 && /library voices/i.test(detail)) {
      // 免费账号经 API 只能用 premade/自有音色，library 音色 402。
      throw new Error(
        `ElevenLabs TTS: HTTP 402 - ${detail}。该 voice_id 是 library 音色（免费账号 API 不可用）：请从音色清单移除它，改用默认 premade 音色或 dashboard ▸ My Voices 里自己添加的音色 id`,
      );
    }
    throw new Error(
      `ElevenLabs TTS: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`,
    );
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  if (pcm.length === 0) {
    throw new Error('ElevenLabs TTS: empty audio response');
  }
  const durationMs = writePcmAsWav(
    pcm,
    ELEVENLABS_PCM_SAMPLE_RATE,
    request.outWavPath,
  );
  return { wavPath: request.outWavPath, durationMs };
}

/**
 * 拉取账号音色清单（GET /v1/voices，需 key 具备 voices_read 权限）：
 * 返回 id→名称，供「配音服务」页把不可读的 voice_id 映射为音色名。
 */
export async function listElevenLabsVoices(
  provider: TtsProvider,
): Promise<Array<{ id: string; name: string }>> {
  const apiKey = String(provider.apiKey ?? '').trim();
  if (!apiKey) throw new Error('ElevenLabs TTS: API key is required');
  const base = normalizeElevenLabsTtsBaseURL(provider.apiUrl);
  const timeoutMs = toPositiveNumber(provider.requestTimeoutSec, 60) * 1000;

  let res: Response;
  try {
    res = await fetch(buildElevenLabsVoicesURL(base), {
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `ElevenLabs TTS: 请求失败（${msg}）。${ELEVEN_NETWORK_HINT}`,
    );
  }
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    if (res.status === 401 && /missing the permission/i.test(detail)) {
      throw new Error(
        `ElevenLabs TTS: HTTP 401 - ${detail}。该 Key 缺少 Voices read 权限：请到 dashboard ▸ API Keys 为此 Key 勾选 Voices 读取权限后重试`,
      );
    }
    throw new Error(
      `ElevenLabs TTS: HTTP ${res.status}${detail ? ` - ${detail}` : ''}`,
    );
  }
  const voices = mapElevenLabsVoices(await res.json());
  if (voices.length === 0) {
    throw new Error('ElevenLabs TTS: 账号音色清单为空');
  }
  return voices;
}

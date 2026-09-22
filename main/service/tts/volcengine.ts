import { v4 as uuidv4 } from 'uuid';
import type {
  TtsProvider,
  TtsSegmentRequest,
} from '../../../types/ttsProvider';
import type { TtsSynthesizeResult } from './types';
import { TaskCancelledError } from '../../helpers/taskContext';
import { writePcmAsWav } from '../../helpers/dubbing/audioPipeline';
import { streamPreviewAudio } from './previewStream';
import {
  VOLC_TTS_SAMPLE_RATE,
  VOLC_TTS_URL,
  buildVolcTtsBody,
  buildVolcTtsHeaders,
  parseVolcTtsStream,
  volcResourceIdForVoice,
  volcTtsErrorHint,
  volcTtsPcmStream,
} from './volcengineTtsUtils';

/**
 * 火山引擎豆包语音合成（V3 单向流式 HTTP，X-Api-Key 鉴权）。
 *
 * - 正式合成校验完整 JSON 流；试听增量解析 PCM 并限制为三秒；
 * - `format=pcm`（24kHz）本地拼 WAV 头零 ffmpeg 落盘（ElevenLabs 同路径）；
 * - speedControl='native'：speed 折算 audio_params.speech_rate [-50,100]；
 * - 错误双轨：HTTP 401/403/429 + 流内业务码（45000000/55000000 等），
 *   经 volcTtsErrorHint 产出定向引导；不做自动重试（失败行单行重跑兜底）。
 */
export async function synthesizeWithVolcengine(
  provider: TtsProvider,
  request: TtsSegmentRequest,
): Promise<TtsSynthesizeResult> {
  const apiKey = String(provider.apiKey ?? '').trim();
  if (!apiKey) throw new Error('豆包 TTS: API Key is required');
  // S_ 克隆音色自动切 seed-icl-2.0（声音复刻资源），普通音色沿用实例配置。
  const resourceId = volcResourceIdForVoice(request.voice, provider.resourceId);
  const timeoutMs = toPositiveNumber(provider.requestTimeoutSec, 60) * 1000;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (request.signal) signals.push(request.signal);

  let res: Response;
  try {
    res = await fetch(VOLC_TTS_URL, {
      method: 'POST',
      headers: buildVolcTtsHeaders(apiKey, resourceId, uuidv4()),
      body: JSON.stringify(
        buildVolcTtsBody(request.text, request.voice, request.speed),
      ),
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    if (request.signal?.aborted) throw new TaskCancelledError();
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`豆包 TTS: 请求失败（${msg}）。请检查网络连接`);
  }

  if (!res.ok) {
    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch (error) {
      if (request.signal?.aborted) throw new TaskCancelledError();
      throw error;
    }
    const parsed = parseVolcTtsStream(bodyText);
    throw new Error(
      volcTtsErrorHint(
        res.status,
        parsed.errorCode,
        parsed.message || bodyText.slice(0, 200),
      ),
    );
  }
  if (!res.body) throw new Error('豆包 TTS: empty audio response');
  if (request.signal?.aborted) {
    await res.body.cancel();
    throw new TaskCancelledError();
  }
  const stream = volcTtsPcmStream(res.body);
  if (request.preview) return streamPreviewAudio(stream, request, true);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    if (request.signal?.aborted) throw new TaskCancelledError();
  } catch (error) {
    if (request.signal?.aborted) throw new TaskCancelledError();
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const pcm = Buffer.concat(chunks);
  if (!pcm.length) throw new Error('豆包 TTS: empty audio response');
  const durationMs = writePcmAsWav(
    pcm,
    VOLC_TTS_SAMPLE_RATE,
    request.outWavPath,
  );
  return { wavPath: request.outWavPath, durationMs };
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

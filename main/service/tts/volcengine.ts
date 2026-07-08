import { v4 as uuidv4 } from 'uuid';
import type {
  TtsProvider,
  TtsSegmentRequest,
} from '../../../types/ttsProvider';
import type { TtsSynthesizeResult } from './types';
import { TaskCancelledError } from '../../helpers/taskContext';
import { writePcmAsWav } from '../../helpers/dubbing/audioPipeline';
import {
  VOLC_TTS_SAMPLE_RATE,
  VOLC_TTS_URL,
  buildVolcTtsBody,
  buildVolcTtsHeaders,
  parseVolcTtsStream,
  volcTtsErrorHint,
} from './volcengineTtsUtils';

/**
 * 火山引擎豆包语音合成（V3 单向流式 HTTP，X-Api-Key 鉴权）。
 *
 * - 一次性输入全部文本，chunked 流式返回 JSON 分片——整段字幕无流式播放
 *   诉求，`res.text()` 全量读取后离线解析（分片 base64 拼裸 PCM）；
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
  const resourceId = String(provider.resourceId ?? '').trim();
  const timeoutMs = toPositiveNumber(provider.requestTimeoutSec, 60) * 1000;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (request.signal) signals.push(request.signal);

  let res: Response;
  let bodyText: string;
  try {
    res = await fetch(VOLC_TTS_URL, {
      method: 'POST',
      headers: buildVolcTtsHeaders(apiKey, resourceId, uuidv4()),
      body: JSON.stringify(
        buildVolcTtsBody(request.text, request.voice, request.speed),
      ),
      signal: AbortSignal.any(signals),
    });
    // chunked 流式响应：读完整个流（错误分片也在流内，一并拿到再判定）。
    bodyText = await res.text();
  } catch (e) {
    if (request.signal?.aborted) throw new TaskCancelledError();
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`豆包 TTS: 请求失败（${msg}）。请检查网络连接`);
  }

  if (!res.ok) {
    const parsed = parseVolcTtsStream(bodyText);
    throw new Error(
      volcTtsErrorHint(
        res.status,
        parsed.errorCode,
        parsed.message || bodyText.slice(0, 200),
      ),
    );
  }
  const parsed = parseVolcTtsStream(bodyText);
  if (parsed.errorCode !== null) {
    throw new Error(
      volcTtsErrorHint(res.status, parsed.errorCode, parsed.message),
    );
  }
  if (parsed.pcm.length === 0) {
    throw new Error('豆包 TTS: empty audio response');
  }
  const durationMs = writePcmAsWav(
    parsed.pcm,
    VOLC_TTS_SAMPLE_RATE,
    request.outWavPath,
  );
  return { wavPath: request.outWavPath, durationMs };
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

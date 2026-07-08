import fs from 'fs';
import path from 'path';
import type {
  TtsProvider,
  TtsSegmentRequest,
} from '../../../types/ttsProvider';
import type { TtsSynthesizeResult } from './types';
import { TaskCancelledError } from '../../helpers/taskContext';
import {
  transcodeToPcm16Wav,
  readWavInfo,
} from '../../helpers/dubbing/audioPipeline';
import {
  buildAzureEndpoint,
  buildAzureSsml,
  buildAzureVoicesListURL,
  mapAzureVoices,
} from './azureUtils';

/**
 * Azure Speech TTS（REST cognitiveservices/v1，subscription key 直传）。
 *
 * - `X-Microsoft-OutputFormat: riff-24khz-16bit-mono-pcm` 直出规范 wav，
 *   落盘校验后不合规才回落 ffmpeg 转码（形制 openaiCompatible 双保险）；
 * - speedControl='ssml'：speed 经 buildAzureSsml 折算为 prosody rate；
 * - 计费含 SSML 标记字符（UI tips 已声明）。
 */

const AZURE_OUTPUT_FORMAT = 'riff-24khz-16bit-mono-pcm';

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 状态码 → 可行动错误信息（401/403 指向 key 与 region 匹配）。 */
export function azureErrorHint(status: number, detail: string): string {
  if (status === 401 || status === 403) {
    return `Azure TTS: HTTP ${status}${detail ? ` - ${detail}` : ''}。请检查 Subscription Key 与 Region 是否匹配（key 必须属于所填 region 的 Speech 资源）`;
  }
  if (status === 404) {
    return `Azure TTS: HTTP 404${detail ? ` - ${detail}` : ''}。合成端点不存在：请确认 Region 与资源所在区域一致，Endpoint 建议留空（自动拼接 https://{region}.tts.speech.microsoft.com）；门户「终结点」域名（*.api.cognitive.*）不是 TTS 端点`;
  }
  if (status === 429) {
    return `Azure TTS: HTTP 429 请求过于频繁（F0 免费层并发/频率配额低），可调低并发或稍后再试${detail ? ` - ${detail}` : ''}`;
  }
  return `Azure TTS: HTTP ${status}${detail ? ` - ${detail}` : ''}`;
}

export async function synthesizeWithAzure(
  provider: TtsProvider,
  request: TtsSegmentRequest,
): Promise<TtsSynthesizeResult> {
  const apiKey = String(provider.apiKey ?? '').trim();
  if (!apiKey) throw new Error('Azure TTS: Subscription Key is required');
  const url = buildAzureEndpoint(
    provider.region as string | undefined,
    provider.endpoint as string | undefined,
  );
  const timeoutMs = toPositiveNumber(provider.requestTimeoutSec, 60) * 1000;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (request.signal) signals.push(request.signal);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
        'User-Agent': 'SmartSub',
      },
      body: buildAzureSsml(request.text, request.voice, request.speed),
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    if (request.signal?.aborted) throw new TaskCancelledError();
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Azure TTS: 请求失败（${msg}）。请检查网络、region 与 endpoint 配置`,
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(azureErrorHint(res.status, detail));
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('Azure TTS: empty audio response');

  // 直出即规范 wav：落盘校验通过则零转码返回。
  fs.mkdirSync(path.dirname(request.outWavPath), { recursive: true });
  fs.writeFileSync(request.outWavPath, audio);
  try {
    const info = readWavInfo(request.outWavPath);
    if (info.bitsPerSample === 16 && info.channels === 1) {
      return { wavPath: request.outWavPath, durationMs: info.durationMs };
    }
  } catch {
    /* 非标准 wav → 转码 */
  }
  const tmp = `${request.outWavPath}.azure-${Date.now()}`;
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

/**
 * 拉取区域音色清单（GET voices/list，与合成同凭据）：返回 id→名称
 * （ShortName → 本地化名 + locale），供「配音服务」页回填名称映射。
 */
export async function listAzureVoices(
  provider: TtsProvider,
): Promise<Array<{ id: string; name: string }>> {
  const apiKey = String(provider.apiKey ?? '').trim();
  if (!apiKey) throw new Error('Azure TTS: Subscription Key is required');
  const url = buildAzureVoicesListURL(
    provider.region as string | undefined,
    provider.endpoint as string | undefined,
  );
  const timeoutMs = toPositiveNumber(provider.requestTimeoutSec, 60) * 1000;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'User-Agent': 'SmartSub',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Azure TTS: 请求失败（${msg}）。请检查网络、region 与 endpoint 配置`,
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(azureErrorHint(res.status, detail));
  }
  const voices = mapAzureVoices(await res.json());
  if (voices.length === 0) {
    throw new Error('Azure TTS: 音色清单为空');
  }
  return voices;
}

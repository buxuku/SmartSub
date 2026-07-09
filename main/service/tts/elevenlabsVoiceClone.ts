import fs from 'fs';
import path from 'path';
import type { TtsProvider } from '../../../types/ttsProvider';
import { logMessage } from '../../helpers/storeManager';
import {
  buildElevenAddVoiceURL,
  buildElevenDeleteVoiceURL,
  elevenCloneErrorHint,
  extractElevenVoiceId,
  mapElevenClonedVoices,
} from './elevenlabsVoiceCloneUtils';
import {
  buildElevenLabsVoicesURL,
  normalizeElevenLabsTtsBaseURL,
} from './elevenlabsTtsUtils';

/**
 * ElevenLabs 即时克隆（IVC）：上传参考音频 → 即返 voice_id（无训练轮询）。
 * 凭据复用 provider 的 xi-api-key。
 */

function apiKeyOf(provider: TtsProvider): string {
  const key = String(provider.apiKey ?? '').trim();
  if (!key)
    throw new Error('ElevenLabs 克隆: 请先在「配音服务」页配置 API Key');
  return key;
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return (
      json?.detail?.message ??
      json?.detail?.status ??
      (typeof json?.detail === 'string' ? json.detail : undefined) ??
      text
    );
  } catch {
    return text;
  }
}

/** 创建即时克隆音色，返回 voice_id。 */
export async function addElevenVoice(
  provider: TtsProvider,
  req: {
    name: string;
    refWavPath: string;
    /** 服务端去背景音（remove_background_noise）。 */
    removeNoise?: boolean;
    signal?: AbortSignal;
  },
): Promise<string> {
  const apiKey = apiKeyOf(provider);
  const form = new FormData();
  form.append('name', req.name);
  if (req.removeNoise) form.append('remove_background_noise', 'true');
  form.append(
    'files',
    new Blob([fs.readFileSync(req.refWavPath)], { type: 'audio/wav' }),
    path.basename(req.refWavPath),
  );

  const signals = [AbortSignal.timeout(120_000)];
  if (req.signal) signals.push(req.signal);
  const res = await fetch(buildElevenAddVoiceURL(provider.apiUrl as string), {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    throw new Error(
      elevenCloneErrorHint(res.status, await readErrorMessage(res)),
    );
  }
  const voiceId = extractElevenVoiceId(await res.json().catch(() => null));
  if (!voiceId) {
    throw new Error('ElevenLabs 克隆: 响应缺少 voice_id');
  }
  return voiceId;
}

/** 账号内即时克隆音色清单（category==='cloned'；「从平台取回」用）。 */
export async function listElevenClonedVoices(
  provider: TtsProvider,
): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(
    buildElevenLabsVoicesURL(
      normalizeElevenLabsTtsBaseURL(provider.apiUrl as string),
    ),
    {
      method: 'GET',
      headers: { 'xi-api-key': apiKeyOf(provider) },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    const detail = await readErrorMessage(res);
    if (res.status === 401 && /missing the permission/i.test(detail)) {
      throw new Error(
        `ElevenLabs 克隆: 该 Key 缺少 Voices 读取权限（HTTP 401）。请到 dashboard ▸ API Keys 勾选 Voices read 后重试`,
      );
    }
    throw new Error(elevenCloneErrorHint(res.status, detail));
  }
  return mapElevenClonedVoices(await res.json().catch(() => null));
}

/** 删除云端音色（显式勾选时 best-effort 同步；失败仅记日志）。 */
export async function deleteElevenVoice(
  provider: TtsProvider,
  voiceId: string,
): Promise<void> {
  try {
    const res = await fetch(
      buildElevenDeleteVoiceURL(provider.apiUrl as string, voiceId),
      {
        method: 'DELETE',
        headers: { 'xi-api-key': apiKeyOf(provider) },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      logMessage(
        `elevenlabs delete voice ${voiceId} failed: HTTP ${res.status} ${await readErrorMessage(res)}`,
        'warning',
      );
    }
  } catch (e) {
    logMessage(`elevenlabs delete voice ${voiceId} failed: ${e}`, 'warning');
  }
}

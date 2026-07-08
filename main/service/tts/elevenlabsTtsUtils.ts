/**
 * ElevenLabs TTS 的纯工具（无网络 / fs / electron），test:dubbing 单测覆盖。
 * 与 ASR 侧 elevenlabsUtils 独立（端点与折算语义不同，互不复用）。
 */

const ELEVENLABS_DEFAULT_BASE = 'https://api.elevenlabs.io/v1';

/** 文档推荐的 speed 保守区间；超界部分模型返回 422，残余交给 atempo 复测。 */
export const ELEVENLABS_SPEED_MIN = 0.7;
export const ELEVENLABS_SPEED_MAX = 1.2;

/** pcm_24000 输出：24kHz 16-bit 单声道小端裸 PCM。 */
export const ELEVENLABS_OUTPUT_FORMAT = 'pcm_24000';
export const ELEVENLABS_PCM_SAMPLE_RATE = 24000;

/**
 * 规范化 Base URL：空/非法 → 官方默认；去误粘的 /text-to-speech 后缀；去尾斜杠。
 */
export function normalizeElevenLabsTtsBaseURL(apiUrl?: string): string {
  const trimmed = apiUrl?.trim();
  if (!trimmed) return ELEVENLABS_DEFAULT_BASE;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return ELEVENLABS_DEFAULT_BASE;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return ELEVENLABS_DEFAULT_BASE;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname =
    normalizedPath.replace(/\/text-to-speech(\/[^/]*)?$/i, '') || '/';
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

/** 拼接合成端点：`{base}/text-to-speech/{voiceId}?output_format=pcm_24000`。 */
export function buildElevenLabsTtsURL(
  baseURL: string,
  voiceId: string,
): string {
  return `${baseURL.replace(/\/$/, '')}/text-to-speech/${encodeURIComponent(
    voiceId.trim(),
  )}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
}

/** 拼接账号音色清单端点：`{base}/voices`（GET，需 voices_read 权限）。 */
export function buildElevenLabsVoicesURL(baseURL: string): string {
  return `${baseURL.replace(/\/$/, '')}/voices`;
}

/** /v1/voices 响应 → [{id, name}]（宽容解析，坏条目跳过）。 */
export function mapElevenLabsVoices(
  raw: unknown,
): Array<{ id: string; name: string }> {
  const voices = (raw as { voices?: unknown })?.voices;
  if (!Array.isArray(voices)) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const v of voices) {
    const id = String((v as { voice_id?: unknown })?.voice_id ?? '').trim();
    const name = String((v as { name?: unknown })?.name ?? '').trim();
    if (id) out.push({ id, name: name || id });
  }
  return out;
}

/** speed clamp 到保守区间 [0.7, 1.2]；无效值回落 1。 */
export function clampElevenLabsSpeed(speed: number | undefined): number {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.min(ELEVENLABS_SPEED_MAX, Math.max(ELEVENLABS_SPEED_MIN, s));
}

/** 请求 body：speed≈1 时省略 voice_settings（沿用音色默认设置）。 */
export function buildElevenLabsBody(
  text: string,
  modelId: string,
  speed?: number,
): {
  text: string;
  model_id: string;
  voice_settings?: { speed: number };
} {
  const clamped = clampElevenLabsSpeed(speed);
  return {
    text,
    model_id: modelId,
    ...(Math.abs(clamped - 1) > 1e-3
      ? { voice_settings: { speed: clamped } }
      : {}),
  };
}

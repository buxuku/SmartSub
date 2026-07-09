/**
 * ElevenLabs 即时克隆（IVC）的纯工具（无网络 / fs / electron），
 * test:voice-clone 单测覆盖。Base 规范化复用 elevenlabsTtsUtils。
 */
import { normalizeElevenLabsTtsBaseURL } from './elevenlabsTtsUtils';

/** 创建音色端点：`{base}/voices/add`（POST multipart）。 */
export function buildElevenAddVoiceURL(apiUrl?: string): string {
  return `${normalizeElevenLabsTtsBaseURL(apiUrl)}/voices/add`;
}

/** 删除音色端点：`{base}/voices/{voiceId}`（DELETE）。 */
export function buildElevenDeleteVoiceURL(
  apiUrl: string | undefined,
  voiceId: string,
): string {
  return `${normalizeElevenLabsTtsBaseURL(apiUrl)}/voices/${encodeURIComponent(
    voiceId.trim(),
  )}`;
}

/** /v1/voices/add 响应 → voice_id（缺失返回 null）。 */
export function extractElevenVoiceId(payload: unknown): string | null {
  const id = (payload as { voice_id?: unknown })?.voice_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * 错误定向文案：401/403 凭据、voice_limit_reached 槽位上限、
 * 素材质量拒绝（audio/sample 相关校验），其余回落原始信息。
 */
export function elevenCloneErrorHint(
  httpStatus: number,
  message: string,
): string {
  const raw = `（HTTP ${httpStatus}: ${(message || 'unknown').slice(0, 200)}）`;
  if (httpStatus === 401 || httpStatus === 403) {
    return `ElevenLabs 克隆: API Key 无效或无权限${raw}。请检查 Key 并确认套餐包含即时克隆（Starter 及以上）`;
  }
  const text = (message || '').toLowerCase();
  if (text.includes('voice_limit') || text.includes('voice limit')) {
    return `ElevenLabs 克隆: 音色槽位已满${raw}。请在 ElevenLabs 控制台删除不用的克隆音色，或升级套餐`;
  }
  if (
    text.includes('sample') ||
    text.includes('audio') ||
    text.includes('quality') ||
    text.includes('too short') ||
    text.includes('too long')
  ) {
    return `ElevenLabs 克隆: 参考音频未通过服务端校验${raw}。请更换更清晰、时长 1–2 分钟的素材`;
  }
  return `ElevenLabs 克隆: 请求失败${raw}`;
}

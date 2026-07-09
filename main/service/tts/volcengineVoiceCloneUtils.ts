/**
 * 火山「声音复刻 2.0」（ICL）训练/状态接口的纯工具（无网络 / fs / electron），
 * test:voice-clone 单测覆盖。
 *
 * 与合成侧 volcengineTtsUtils 独立：训练接口走旧版双凭据
 * （X-Api-App-Key + X-Api-Access-Key），与合成的单 X-Api-Key 并存；
 * 请求体字段名官方文档参数表（`audio`）与示例（`audios`）不一致——
 * 真机实测（2026-07-09）：`audios` 被服务端报 unmapped key
 * （"add unmapped key audios to params store"），以参数表 `audio` 为准。
 */

export const VOLC_CLONE_TRAIN_URL =
  'https://openspeech.bytedance.com/api/v3/tts/voice_clone';
/**
 * V3 状态查询端点（2026-07-09 真机定稿）：`POST /api/v3/tts/get_voice`——
 * 文档主篇写的 `/api/v3/tts/voice_clone/status` 实测 404（"Endpoint does
 * not exist"）。响应：顶层 `status`（0–4）+ `speaker_status[]` 列表 +
 * `demo_audio` + `available_training_times`。
 */
export const VOLC_CLONE_STATUS_URL =
  'https://openspeech.bytedance.com/api/v3/tts/get_voice';
/**
 * V1 状态查询（社区实测可用形态）：`Bearer;<token>` +
 * `Resource-Id: volc.megatts.voiceclone`，body `{appid, speaker_id}`。
 * 作为 V3 的回退通道。
 */
export const VOLC_CLONE_STATUS_URL_V1 =
  'https://openspeech.bytedance.com/api/v1/mega_tts/status';

/** 训练音频上限（官方 10MB）。 */
export const VOLC_CLONE_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** 克隆音色（S_ 槽位）判定：合成资源路由与工作台注入共用。 */
export function isVolcCloneSpeaker(voice: unknown): boolean {
  return typeof voice === 'string' && voice.startsWith('S_');
}

/**
 * 合成资源版本路由：S_ 克隆音色 → seed-icl-2.0（ICL 2.0 字符版），
 * 其余音色沿用实例配置。空/无效 configured 由调用方兜底默认值。
 */
export function volcResourceIdForVoice(
  voice: unknown,
  configured: string,
): string {
  return isVolcCloneSpeaker(voice) ? 'seed-icl-2.0' : configured;
}

/** 训练/状态接口鉴权 header（双凭据）。 */
export function buildVolcCloneHeaders(
  appId: unknown,
  accessToken: unknown,
  requestId: string,
): Record<string, string> {
  return {
    'X-Api-App-Key': String(appId ?? '').trim(),
    'X-Api-Access-Key': String(accessToken ?? '').trim(),
    'X-Api-Request-Id': requestId,
    'Content-Type': 'application/json',
  };
}

/** V1 状态接口鉴权 header（Bearer 分号形态为官方约定，非笔误）。 */
export function buildVolcCloneV1Headers(
  accessToken: unknown,
): Record<string, string> {
  return {
    Authorization: `Bearer;${String(accessToken ?? '').trim()}`,
    'Resource-Id': 'volc.megatts.voiceclone',
    'Content-Type': 'application/json',
  };
}

export interface VolcCloneTrainOptions {
  /** 服务端降噪（默认关；损相似度，噪音黄牌素材建议开）。 */
  denoise?: boolean;
  /** 音源分离去背景音（默认关）。 */
  mss?: boolean;
}

/**
 * 训练请求体：`model_types: [4]` = ICL 2.0；language cn=0 / en=1；
 * extra_params 仅在开关开启时携带对应字段（缺省走服务端默认）。
 */
export function buildVolcCloneTrainBody(
  speakerId: string,
  audioBase64: string,
  format: string,
  language: 'zh' | 'en',
  opts?: VolcCloneTrainOptions,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (opts?.denoise) extra.enable_audio_denoise = true;
  if (opts?.mss) extra.voice_clone_enable_mss = true;
  return {
    speaker_id: speakerId,
    audio: { data: audioBase64, format },
    language: language === 'en' ? 1 : 0,
    model_types: [4],
    ...(Object.keys(extra).length > 0 ? { extra_params: extra } : {}),
  };
}

export type VolcCloneTrainState = 'training' | 'ready' | 'failed';

/** 字符串态枚举 → 数字（部分接口/版本返回字符串态）。 */
function statusNumberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (value.trim() !== '' && Number.isFinite(n)) return n;
    const map: Record<string, number> = {
      notfound: 0,
      unknown: 0,
      training: 1,
      success: 2,
      failed: 3,
      fail: 3,
      active: 4,
    };
    const hit = map[value.trim().toLowerCase()];
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * 从响应中提取训练状态数值（多形态兼容）：顶层 `status`、`data.status`、
 * `speaker_status[0].status/state`（列表形态）。找不到返回 null
 * （调用方据此走回退通道，而不是误报训练中）。
 */
export function extractVolcCloneStatusValue(payload: unknown): number | null {
  const p = payload as {
    status?: unknown;
    state?: unknown;
    data?: { status?: unknown; state?: unknown };
    speaker_status?: Array<{ status?: unknown; state?: unknown }>;
  } | null;
  if (!p || typeof p !== 'object') return null;
  const candidates: unknown[] = [
    p.status,
    p.state,
    p.data?.status,
    p.data?.state,
    ...(Array.isArray(p.speaker_status)
      ? p.speaker_status.flatMap((s) => [s?.status, s?.state])
      : []),
  ];
  for (const c of candidates) {
    const n = statusNumberFrom(c);
    if (n !== null) return n;
  }
  return null;
}

/**
 * 状态响应解析：官方 status 枚举——0 NotFound / 1 Training / 2 Success /
 * 3 Failed / 4 Active（2 与 4 均可发起合成）。`found=false` 表示响应里
 * 找不到状态字段（调用方走回退通道）；未知取值按 training 处理
 * （宁可多轮询，不误报失败）。
 */
export function parseVolcCloneStatus(payload: unknown): {
  state: VolcCloneTrainState;
  raw?: number;
  found: boolean;
} {
  const status = extractVolcCloneStatusValue(payload);
  if (status === null) return { state: 'training', found: false };
  if (status === 2 || status === 4)
    return { state: 'ready', raw: status, found: true };
  if (status === 3 || status === 0)
    return { state: 'failed', raw: status, found: true };
  return { state: 'training', raw: status, found: true };
}

/**
 * 训练/状态接口错误定向文案：凭据 / 槽位 / 次数上限 / 音频质量四类。
 * code 来自响应 BaseResp/StatusCode 或 HTTP 层。
 */
export function volcCloneErrorHint(
  httpStatus: number,
  code: number | null,
  message: string,
): string {
  const raw = `（HTTP ${httpStatus}${code !== null ? `, code ${code}` : ''}: ${message || 'unknown'}）`;
  if (httpStatus === 401 || httpStatus === 403) {
    return `豆包声音复刻: 训练凭据无效${raw}。请检查 APP ID 与 Access Token（旧版控制台「语音技术」应用凭据），并确认已开通声音复刻服务`;
  }
  const text = `${message || ''}`.toLowerCase();
  if (
    code === 1109 ||
    text.includes('not found') ||
    text.includes('not exist') ||
    text.includes('deleted')
  ) {
    return `豆包声音复刻: 音色槽位不存在${raw}。请确认 speaker_id 正确（S_ 开头，控制台「声音复刻」页购买后可见）且未被删除`;
  }
  if (
    text.includes('limit') ||
    text.includes('exceed') ||
    text.includes('quota')
  ) {
    return `豆包声音复刻: 该槽位训练次数已达上限${raw}。请更换还有训练次数的 speaker_id`;
  }
  if (
    text.includes('wer') ||
    text.includes('snr') ||
    text.includes('quality') ||
    text.includes('denoise')
  ) {
    // 注意不可用裸 'audio' 匹配：参数错误类 message 也含该词
    // （真机踩坑："add unmapped key audios ..."）。
    return `豆包声音复刻: 参考音频未通过服务端质检${raw}。请更换更清晰的素材，或在创建时开启服务端降噪`;
  }
  return `豆包声音复刻: 请求失败${raw}`;
}

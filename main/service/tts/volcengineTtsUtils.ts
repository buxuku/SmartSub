/**
 * 火山引擎豆包「语音合成大模型」（V3 单向流式 HTTP，`/api/v3/tts/unidirectional`）
 * 的纯工具（无网络 / fs / electron），test:dubbing 单测覆盖。
 *
 * 与 ASR 侧 volcengineUtils 独立（端点与响应形态不同）：TTS 的业务状态码在
 * chunked 流内 JSON 分片（`{code, message, data}`，data 为 base64 音频，
 * 终止分片 code=20000000），HTTP 层另有 401/403/429。
 */

export const VOLC_TTS_URL =
  'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
/** format=pcm 直出：24kHz 16-bit 单声道小端裸 PCM。 */
export const VOLC_TTS_SAMPLE_RATE = 24000;

/**
 * 构造鉴权 header：新版「豆包语音」控制台单 API Key（`X-Api-Key`，与豆包听写
 * ASR 同 Key 体系；火山方舟 / 大模型推理的 API Key 不通用，会 401）。
 * `X-Api-Resource-Id` 选择模型版本与计费商品，须与音色版本匹配。
 */
export function buildVolcTtsHeaders(
  apiKey: unknown,
  resourceId: unknown,
  requestId: string,
): Record<string, string> {
  return {
    'X-Api-Key': String(apiKey ?? '').trim(),
    'X-Api-Resource-Id': String(resourceId ?? '').trim() || 'seed-tts-2.0',
    'X-Api-Request-Id': requestId,
    'Content-Type': 'application/json',
  };
}

/**
 * 合成资源版本按音色路由：`S_` 开头为控制台购买的克隆音色槽位，
 * 须以 `seed-icl-2.0`（声音复刻 ICL 2.0 字符版）发起；其余沿用实例配置。
 */
export function volcResourceIdForVoice(
  voice: unknown,
  configured: unknown,
): string {
  if (typeof voice === 'string' && voice.startsWith('S_')) {
    return 'seed-icl-2.0';
  }
  return String(configured ?? '').trim();
}

/**
 * speed（倍速）→ `audio_params.speech_rate`：官方定义 -50 = 0.5 倍速、
 * 0 = 原速、100 = 2 倍速，恰为线性 `(speed - 1) × 100`，clamp [-50, 100]
 * （即倍速 [0.5, 2.0]，完整覆盖对齐引擎实用区间）。
 * 无效值或折算后 ≈ 0 返回 null（调用方省略字段，走服务端默认）。
 */
export function speedToVolcSpeechRate(
  speed: number | undefined,
): number | null {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return null;
  const rate = Math.round((s - 1) * 100);
  if (rate === 0) return null;
  return Math.min(100, Math.max(-50, rate));
}

/**
 * 构造请求体：`user.uid` 为必填的任意调用方标识，固定应用名（同 ASR 侧）。
 * `format=pcm`（流式场景官方明示 wav 会多次返回 header，不可用）；
 * speech_rate 为 null 时省略字段。
 */
export function buildVolcTtsBody(
  text: string,
  speaker: string,
  speed?: number,
): Record<string, unknown> {
  const speechRate = speedToVolcSpeechRate(speed);
  return {
    user: { uid: 'video-subtitle-master' },
    req_params: {
      text,
      speaker,
      audio_params: {
        format: 'pcm',
        sample_rate: VOLC_TTS_SAMPLE_RATE,
        ...(speechRate !== null ? { speech_rate: speechRate } : {}),
      },
    },
  };
}

/** parseVolcTtsStream 的结构化产物（成败判定交给调用方）。 */
export interface VolcTtsStreamResult {
  /** 各音频分片 base64 解码后的按序拼接（裸 PCM）。 */
  pcm: Buffer;
  /** 首个错误分片的 code（非 0 且非 20000000）；无错误为 null。 */
  errorCode: number | null;
  /** 终止分片 code（20000000 成功收尾）；未见终止分片为 null。 */
  endCode: number | null;
  /** 错误或终止分片携带的 message（先到先记）。 */
  message: string;
}

/**
 * 从 chunked 响应全文提取顶层 JSON 分片（brace 扫描，兼容「按行分隔」与
 * 「无分隔直拼」两种形态），字符串内的花括号/转义按 JSON 语义跳过。
 */
function extractJsonChunks(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * 解析 chunked 流全文（2026-07 真机实测：正常流按行分隔 JSON 分片；
 * HTTP 401 等错误 body 为 `{"header":{"code":45000010,"message":...}}` 形态）：
 * - 音频分片（code=0 且 data 非空）→ base64 解码按序拼 PCM；
 * - 终止分片（code=20000000）→ 记 endCode；
 * - 错误分片（顶层 code 或 header.code 非 0 且非 20000000）→ 记首个
 *   errorCode + message 并停止（后续分片不再消费）；
 * - 无法解析的分片跳过（容错半行/空行）。
 */
export function parseVolcTtsStream(text: string): VolcTtsStreamResult {
  const result: VolcTtsStreamResult = {
    pcm: Buffer.alloc(0),
    errorCode: null,
    endCode: null,
    message: '',
  };
  const buffers: Buffer[] = [];
  for (const raw of extractJsonChunks(text)) {
    let chunk: {
      code?: unknown;
      message?: unknown;
      data?: unknown;
      header?: { code?: unknown; message?: unknown };
    };
    try {
      chunk = JSON.parse(raw);
    } catch {
      continue;
    }
    const code = Number(chunk?.code ?? chunk?.header?.code ?? 0);
    if (code === 0) {
      if (typeof chunk?.data === 'string' && chunk.data) {
        buffers.push(Buffer.from(chunk.data, 'base64'));
      }
      continue;
    }
    if (code === 20000000) {
      result.endCode = code;
      if (!result.message) result.message = String(chunk?.message ?? '');
      continue;
    }
    result.errorCode = code;
    result.message = String(chunk?.message ?? chunk?.header?.message ?? '');
    break;
  }
  result.pcm = Buffer.concat(buffers);
  return result;
}

/**
 * 错误分类 → 可行动文案（design 决策 5，按 2026-07 真机实测修正）：
 * HTTP 层与流内业务码双轨判定。
 * - HTTP 401/403：凭据（实测无效 Key = 401 + header.code 45000010
 *   "Invalid X-Api-Key"；方舟 Key 不通用 / 服务未开通）；
 * - HTTP 429 或 message 含 concurrency/quota：并发限流；
 * - 45000000 + speaker/permission：音色未授权（如未购音色/克隆音色越权）；
 * - 55000000 + mismatch：实测「坏音色 id」与「资源版本错配」同报此码，
 *   文案同时覆盖两种成因；
 * - 40402003：单请求文本超长（发起前有 maxCharsPerRequest 守卫，属兜底）。
 */
export function volcTtsErrorHint(
  httpStatus: number,
  code: number | null,
  message: string,
): string {
  const detail = [
    code !== null ? `code ${code}` : '',
    (message ?? '').trim().slice(0, 200),
  ]
    .filter(Boolean)
    .join(' ');
  const suffix = detail ? ` - ${detail}` : '';
  const msg = (message ?? '').toLowerCase();

  if (httpStatus === 401 || httpStatus === 403) {
    return `豆包 TTS: HTTP ${httpStatus}${suffix}。请检查 API Key：需为「豆包语音」控制台签发（火山方舟/大模型推理的 Key 不通用），并确认账号已开通语音合成大模型服务`;
  }
  if (httpStatus === 429 || /concurrency|quota/.test(msg)) {
    return `豆包 TTS: 并发/配额受限${suffix}。请调低该实例的并发（默认 2）或稍后重试；免费赠额与字符版的并发上限有限`;
  }
  if (code === 45000000 && /speaker|permission/.test(msg)) {
    return `豆包 TTS: 音色不可用${suffix}。请检查音色 id 拼写是否正确、账号是否已开通该音色对应的商品；克隆音色（S_ 开头）需确认训练已完成且属于当前账号`;
  }
  if (code === 55000000 && /mismatch/.test(msg)) {
    return `豆包 TTS: 音色 id 有误或与资源版本不匹配${suffix}。请检查音色 id 拼写；2.0 音色（*_uranus_bigtts 等）需选 seed-tts-2.0，1.0 音色（*_mars/moon_bigtts 等）需选 seed-tts-1.0`;
  }
  if (code === 40402003) {
    return `豆包 TTS: 单请求文本超长${suffix}。请拆分该行字幕`;
  }
  return `豆包 TTS: 合成失败（HTTP ${httpStatus}${suffix}）`;
}

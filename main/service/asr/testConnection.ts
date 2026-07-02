import { randomUUID } from 'crypto';
import {
  ASR_ALIYUN,
  ASR_DEEPGRAM,
  ASR_ELEVENLABS,
  ASR_TENCENT,
  ASR_VOLCENGINE,
  ASR_XFYUN,
  parseAsrModels,
  type AsrProvider,
} from '../../../types/asrProvider';
import { normalizeBaseURL } from './openaiCompatUtils';
import { normalizeElevenLabsBaseURL } from './elevenlabsUtils';
import { normalizeDeepgramBaseURL } from './deepgramUtils';
import {
  VOLC_FLASH_PATH,
  buildSilentWavBase64,
  buildVolcHeaders,
  buildVolcRequestBody,
  classifyVolcStatus,
  normalizeVolcBaseURL,
} from './volcengineUtils';
import {
  TENCENT_ASR_HOST,
  TENCENT_FLASH_PATH,
  buildTencentParams,
  buildTencentQuery,
  resolveTencentEngineType,
  signTencentRequest,
} from './tencentUtils';
import {
  ALIYUN_FLASH_PATH,
  ALIYUN_NLS_GATEWAY_HOST,
  buildFlashQuery,
} from './aliyunUtils';
import { getAliyunToken } from './aliyun';
import {
  XFYUN_API_HOST,
  XFYUN_GET_RESULT_PATH,
  buildXfyunDateTime,
  buildXfyunQuery,
  buildXfyunRandom,
  signXfyunRequest,
} from './xfyunUtils';

export interface AsrTestResult {
  ok: boolean;
  /** HTTP 状态码（请求已达服务端但鉴权/参数失败时）。 */
  status?: number;
  /** 缺少必填凭据（key / base url），供前端提示「先填配置」。 */
  needsConfig?: boolean;
  /** 服务端返回的失败原因（如「缺少 speech_to_text 权限」），便于用户直达症结。 */
  detail?: string;
}

const TEST_TIMEOUT_MS = 15000;

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(TEST_TIMEOUT_MS);
}

/** 从各服务商错误响应体里尽力抽出一句人类可读的原因。 */
async function readError(res: Response): Promise<string | undefined> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as {
      detail?: unknown;
      error?: { message?: unknown };
      err_msg?: unknown;
      message?: unknown;
    };
    const detail = j?.detail as { message?: unknown } | string | undefined;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
    if (detail && typeof detail === 'object' && detail.message) {
      return String(detail.message);
    }
    if (j?.error?.message) return String(j.error.message);
    if (j?.err_msg) return String(j.err_msg);
    if (j?.message) return String(j.message);
  } catch {
    /* 非 JSON：回落截断文本 */
  }
  return text.slice(0, 200);
}

/**
 * 云 ASR 实例连通性/鉴权自测（跑在主进程，规避渲染进程 CORS，对齐 testTranslation）。
 *
 * 鉴权在服务端「参数校验之前」执行——用「操作端点的最小探测」判定 key 是否可用于该操作，
 * 而非 /models 这类可能被「按端点限权（scope）」拒绝的资源端点：
 * - OpenAI 兼容：GET /models；
 * - ElevenLabs：POST /speech-to-text 仅带 model_id、不带 file → 有权限的 key 得 400/422（缺 file），
 *   无效/缺 speech_to_text 权限的 key 得 401（ElevenLabs 对权限问题也返回 401，detail 带原因）；
 * - Deepgram：POST /listen 空体 → 有效 key 得 400（无音频），无效 key 得 401。
 * - 火山豆包：POST recognize/flash 携 1s 静音 WAV（参数校验先于鉴权，空体探测对假 key 也「通过」）→
 *   有效 API Key 得 20000000/20000003（静音空结果），无效得 HTTP 401/403，detail 取 X-Api-Message。
 * - 腾讯极速版：POST flash/v1 携 1s 静音 WAV 完整签名探测（沿用豆包教训，最小真实音频）→
 *   有效凭据得 code 0（静音空文本），4002 鉴权失败，4003/4004/4005 开通/额度/欠费可行动提示。
 * - 阿里极速版：两段探测——CreateToken 验 AccessKey（失败即密钥/签名问题），再携 1s 静音 WAV
 *   POST FlashRecognizer 验 appkey 与开通状态（20000000/40270002 均通过；40000010 未开通商用、
 *   40020105/40020106 appkey 问题，均给可行动提示）。
 * 失败时回传服务端 detail，前端直接展示（如「缺少 speech_to_text 权限」）。
 */
export async function testAsrConnection(
  provider: AsrProvider,
): Promise<AsrTestResult> {
  // 腾讯/阿里/讯飞是多字段凭据，按自身守卫，不走下方通用 apiKey 守卫。
  if (provider?.type === ASR_TENCENT) {
    return testTencentConnection(provider);
  }
  if (provider?.type === ASR_ALIYUN) {
    return testAliyunConnection(provider);
  }
  if (provider?.type === ASR_XFYUN) {
    return testXfyunConnection(provider);
  }

  const apiKey = String(provider?.apiKey ?? '').trim();
  if (!apiKey) return { ok: false, needsConfig: true };

  try {
    if (provider?.type === ASR_VOLCENGINE) {
      const base = normalizeVolcBaseURL(provider.apiUrl);
      const res = await fetch(`${base}${VOLC_FLASH_PATH}`, {
        method: 'POST',
        headers: buildVolcHeaders(apiKey, randomUUID()),
        body: JSON.stringify(
          buildVolcRequestBody(
            buildSilentWavBase64(),
            parseAsrModels(provider)[0] || 'bigmodel',
          ),
        ),
        signal: timeoutSignal(),
      });
      const code = res.headers.get('X-Api-Status-Code');
      const cls = classifyVolcStatus(res.status, code);
      // 1s 静音 → 成功或静音空结果均证明凭据可用。
      if (cls === 'success' || cls === 'empty') return { ok: true };
      const message = res.headers.get('X-Api-Message');
      return {
        ok: false,
        status: res.status,
        detail: message || (await readError(res)),
      };
    }

    if (provider?.type === ASR_ELEVENLABS) {
      const base = normalizeElevenLabsBaseURL(provider.apiUrl);
      const form = new FormData();
      form.append('model_id', parseAsrModels(provider)[0] || 'scribe_v2');
      const res = await fetch(`${base}/speech-to-text`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
        signal: timeoutSignal(),
      });
      // 有权限的 key → 400/422（缺 file）；无效/无 speech_to_text 权限 → 401/403。
      if (res.ok || res.status === 400 || res.status === 422)
        return { ok: true };
      return { ok: false, status: res.status, detail: await readError(res) };
    }

    if (provider?.type === ASR_DEEPGRAM) {
      const base = normalizeDeepgramBaseURL(provider.apiUrl);
      const res = await fetch(`${base}/listen`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'audio/wav',
        },
        body: new Uint8Array(0),
        signal: timeoutSignal(),
      });
      // 有效 key → 400（无音频体）；无效 key → 401。
      if (res.ok || res.status === 400) return { ok: true };
      return { ok: false, status: res.status, detail: await readError(res) };
    }

    // OpenAI 兼容
    const apiUrl = String(provider?.apiUrl ?? '').trim();
    if (!apiUrl) return { ok: false, needsConfig: true };
    const base = normalizeBaseURL(apiUrl);
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: timeoutSignal(),
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, detail: await readError(res) };
  } catch (error) {
    // Base URL 非法（openai 归一会抛）→ 视为配置问题；其余（网络/超时）→ 普通失败。
    if (error instanceof Error && /base URL/i.test(error.message)) {
      return { ok: false, needsConfig: true };
    }
    return { ok: false };
  }
}

/**
 * 配置类错误码的可行动提示（design D6：新用户大概率首撞 4003 未开通，
 * 明确文案省一轮排查）；服务端原始 message 追加在后供比对。
 */
const TENCENT_CODE_HINTS: Record<number, string> = {
  4002: '鉴权失败：请检查 SecretID / SecretKey 是否正确（系统时间偏差超过 3 分钟也会导致签名失败）',
  4003: '服务未开通：请先在腾讯云语音识别控制台开通「录音文件识别极速版」',
  4004: '免费额度已用尽：请在控制台购买资源包或开通后付费',
  4005: '账号欠费：请充值后重试',
};

/** 腾讯极速版：1s 静音 WAV 原始字节 + 完整签名真实探测，按响应 code 语义判定。 */
async function testTencentConnection(
  provider: AsrProvider,
): Promise<AsrTestResult> {
  const appid = String(provider?.appid ?? '').trim();
  const secretId = String(provider?.secretId ?? '').trim();
  const secretKey = String(provider?.secretKey ?? '').trim();
  if (!appid || !secretId || !secretKey) {
    return { ok: false, needsConfig: true };
  }

  try {
    // 首个已启用档位按中文映射真实 engine_type 探测（large 档同时验证大模型版可用性）。
    const engineType =
      resolveTencentEngineType(parseAsrModels(provider)[0], 'zh') || '16k_zh';
    const query = buildTencentQuery(
      buildTencentParams({
        secretId,
        engineType,
        voiceFormat: 'wav',
        timestamp: Math.floor(Date.now() / 1000),
      }),
    );
    const res = await fetch(
      `https://${TENCENT_ASR_HOST}${TENCENT_FLASH_PATH}${appid}?${query}`,
      {
        method: 'POST',
        headers: {
          Authorization: signTencentRequest(secretKey, appid, query),
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from(buildSilentWavBase64(), 'base64'),
        signal: timeoutSignal(),
      },
    );
    let data: { code?: unknown; message?: unknown } | undefined;
    try {
      data = JSON.parse(await res.text());
    } catch {
      data = undefined;
    }
    const code = Number(data?.code);
    // 1s 静音 → code 0 空文本即证明凭据可用（开通 + 鉴权 + 额度全通过）。
    if (Number.isFinite(code) && code === 0) return { ok: true };
    const message = String(data?.message ?? '').trim();
    const hint = TENCENT_CODE_HINTS[code];
    const detail = hint
      ? `${hint}${message ? `（${message}）` : ''}`
      : message || undefined;
    return {
      ok: false,
      status: res.ok ? undefined : res.status,
      detail: detail
        ? `${detail}${Number.isFinite(code) ? ` (code ${code})` : ''}`
        : undefined,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * 配置类 status 的可行动提示（design D6，均为 2026-07 实测形态）：
 * 40000010 实测先于 appkey 校验（未开通时无法判断 appkey 正误），单列因极速版
 * 无免费试用、新用户最易撞；40020105/40020106 在商用开通后才可能出现。
 */
const ALIYUN_STATUS_HINTS: Record<number, string> = {
  40000010:
    '服务未开通或欠费：录音文件识别极速版仅提供商用版（无免费试用），请先在阿里云智能语音交互控制台开通商用版',
  40020105:
    'Appkey 不存在：请在智能语音交互控制台「全部项目」创建项目并复制其 Appkey',
  40020106:
    'Appkey 与账号不匹配：请使用当前 AccessKey 所属账号下创建的项目 Appkey',
};

/**
 * 阿里极速版：两段探测（design D6）——
 * 1) CreateToken 验 AccessKey（POP 签名，走缓存）：失败即密钥/签名类问题，透出 Code/Message；
 * 2) 1s 静音 WAV 原始字节 POST FlashRecognizer 验 appkey 与开通状态：
 *    20000000（成功）/ 40270002（vad silent，静音被拒识属预期）均判通过。
 */
async function testAliyunConnection(
  provider: AsrProvider,
): Promise<AsrTestResult> {
  const accessKeyId = String(provider?.accessKeyId ?? '').trim();
  const accessKeySecret = String(provider?.accessKeySecret ?? '').trim();
  const appkey = String(provider?.appkey ?? '').trim();
  if (!accessKeyId || !accessKeySecret || !appkey) {
    return { ok: false, needsConfig: true };
  }

  let token: string;
  try {
    token = await getAliyunToken(accessKeyId, accessKeySecret);
  } catch (error) {
    // CreateToken 失败 = AccessKey/签名类问题（错误信息已含服务端 Code/Message）。
    return {
      ok: false,
      detail:
        error instanceof Error
          ? error.message.replace(
              /^Aliyun ASR CreateToken failed:\s*/,
              'AccessKey 校验失败：',
            )
          : undefined,
    };
  }

  try {
    const query = buildFlashQuery({ appkey, token, format: 'wav' });
    const res = await fetch(
      `https://${ALIYUN_NLS_GATEWAY_HOST}${ALIYUN_FLASH_PATH}?${query}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(buildSilentWavBase64(), 'base64'),
        signal: timeoutSignal(),
      },
    );
    let data: { status?: unknown; message?: unknown } | undefined;
    try {
      data = JSON.parse(await res.text());
    } catch {
      data = undefined;
    }
    const status = Number(data?.status);
    // 20000000 成功；40270002 vad silent——静音探针被拒识属预期，链路/凭据/开通均已验证。
    if (status === 20000000 || status === 40270002) return { ok: true };
    const message = String(data?.message ?? '').trim();
    const hint = ALIYUN_STATUS_HINTS[status];
    const detail = hint
      ? `${hint}${message ? `（${message}）` : ''}`
      : message || undefined;
    return {
      ok: false,
      status: res.ok ? undefined : res.status,
      detail: detail
        ? `${detail}${Number.isFinite(status) ? ` (status ${status})` : ''}`
        : undefined,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * 配置类错误码的可行动提示（design D9，均为 2026-07 实测形态）。
 * 探针无法验证服务开通/余量——那类问题（100007 等）首次真实转写时由 upload 文案兜底。
 */
const XFYUN_CODE_HINTS: Record<string, string> = {
  '000002':
    'APIKey 不存在或已被禁用：请检查控制台「服务接口认证信息」中的 APIKey',
  '100009': '签名校验失败：请检查 APISecret 是否正确',
  '100008': '请求时间超限：请检查系统时间是否准确（偏差过大会导致签名失效）',
  '100007': '权限错误：请确认已在讯飞开放平台开通「录音文件转写大模型」服务',
};

/**
 * 讯飞大模型转写：假 orderId + 完整签名探测 getResult（design D9，零成本——
 * 不上传音频、不创建订单、不消耗转写时长）。签名通过则进入业务校验报
 * `100037`（orderId is illegal）→ 凭据有效；否则按鉴权错误码给可行动提示。
 */
async function testXfyunConnection(
  provider: AsrProvider,
): Promise<AsrTestResult> {
  const appid = String(provider?.appid ?? '').trim();
  const apiKey = String(provider?.apiKey ?? '').trim();
  const apiSecret = String(provider?.apiSecret ?? '').trim();
  if (!appid || !apiKey || !apiSecret) {
    return { ok: false, needsConfig: true };
  }

  try {
    const query = buildXfyunQuery({
      appId: appid,
      accessKeyId: apiKey,
      dateTime: buildXfyunDateTime(),
      signatureRandom: buildXfyunRandom(),
      orderId: `SMARTSUB_PROBE_${Date.now()}`,
      resultType: 'transfer',
    });
    const res = await fetch(
      `https://${XFYUN_API_HOST}${XFYUN_GET_RESULT_PATH}?${query}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          signature: signXfyunRequest(apiSecret, query),
        },
        body: '{}',
        signal: timeoutSignal(),
      },
    );
    let data: { code?: unknown; descInfo?: unknown } | undefined;
    try {
      data = JSON.parse(await res.text());
    } catch {
      data = undefined;
    }
    const code = String(data?.code ?? '').trim();
    // 签名通过 → 业务层报「订单不存在/非法」（100037/100001/100039）→ 凭据有效。
    if (code === '100037' || code === '100001' || code === '100039') {
      return { ok: true };
    }
    const message = String(data?.descInfo ?? '').trim();
    const hint = XFYUN_CODE_HINTS[code];
    const detail = hint
      ? `${hint}${message ? `（${message}）` : ''}`
      : message || undefined;
    return {
      ok: false,
      status: res.ok ? undefined : res.status,
      detail: detail ? `${detail}${code ? ` (code ${code})` : ''}` : undefined,
    };
  } catch {
    return { ok: false };
  }
}

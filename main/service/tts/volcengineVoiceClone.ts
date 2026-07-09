import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { TtsProvider } from '../../../types/ttsProvider';
import { logMessage } from '../../helpers/storeManager';
import {
  VOLC_CLONE_MAX_AUDIO_BYTES,
  VOLC_CLONE_STATUS_URL,
  VOLC_CLONE_STATUS_URL_V1,
  VOLC_CLONE_TRAIN_URL,
  buildVolcCloneHeaders,
  buildVolcCloneTrainBody,
  buildVolcCloneV1Headers,
  parseVolcCloneStatus,
  volcCloneErrorHint,
  type VolcCloneTrainOptions,
  type VolcCloneTrainState,
} from './volcengineVoiceCloneUtils';

/**
 * 火山声音复刻 2.0 训练/状态调用（ICL：上传 10–30s 参考音频到 S_ 槽位，
 * 分钟级内可用）。凭据为豆包 provider 实例的可选 appId/accessToken 双凭据。
 */

function cloneCredentials(provider: TtsProvider): {
  appId: string;
  accessToken: string;
} {
  const appId = String(provider.appId ?? '').trim();
  const accessToken = String(provider.accessToken ?? '').trim();
  if (!appId || !accessToken) {
    throw new Error(
      '豆包声音复刻: 缺少训练凭据。请在「配音服务」页豆包实例中填写 APP ID 与 Access Token',
    );
  }
  return { appId, accessToken };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ httpStatus: number; payload: any; rawText: string }> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });
  const rawText = await res.text();
  let payload: any = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    /* 保留 rawText 供错误文案 */
  }
  return { httpStatus: res.status, payload, rawText };
}

function extractErrorCode(payload: any): number | null {
  const candidates = [
    payload?.BaseResp?.StatusCode,
    payload?.code,
    payload?.header?.code,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return null;
}

function extractErrorMessage(payload: any, rawText: string): string {
  return (
    payload?.BaseResp?.StatusMessage ??
    payload?.message ??
    payload?.header?.message ??
    rawText.slice(0, 200)
  );
}

/** 上传参考音频训练（一次调用；轮询就绪由调用方编排）。 */
export async function trainVolcCloneVoice(
  provider: TtsProvider,
  req: {
    speakerId: string;
    refWavPath: string;
    language: 'zh' | 'en';
    options?: VolcCloneTrainOptions;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { appId, accessToken } = cloneCredentials(provider);
  const stat = fs.statSync(req.refWavPath);
  if (stat.size > VOLC_CLONE_MAX_AUDIO_BYTES) {
    throw new Error(
      `豆包声音复刻: 参考音频超过 10MB 上限（${Math.round(stat.size / 1024 / 1024)}MB），请缩短选区`,
    );
  }
  const audioBase64 = fs.readFileSync(req.refWavPath).toString('base64');
  const { httpStatus, payload, rawText } = await postJson(
    VOLC_CLONE_TRAIN_URL,
    buildVolcCloneHeaders(appId, accessToken, uuidv4()),
    buildVolcCloneTrainBody(
      req.speakerId,
      audioBase64,
      'wav',
      req.language,
      req.options,
    ),
    120_000,
    req.signal,
  );
  const code = extractErrorCode(payload);
  if (httpStatus >= 400 || code !== null) {
    throw new Error(
      volcCloneErrorHint(
        httpStatus,
        code,
        extractErrorMessage(payload, rawText),
      ),
    );
  }
}

/**
 * 查询训练状态（ready / training / failed）：
 * 主通道 V3 `POST /api/v3/tts/get_voice`（2026-07-09 真机定稿：文档主篇的
 * `/voice_clone/status` 实测 404；本端点响应顶层 `status` 0–4）；
 * 异常或响应无状态字段时回退 V1 `mega_tts/status`（`Bearer;token` +
 * `Resource-Id: volc.megatts.voiceclone`）。两级均无果才抛错（带原始
 * 响应片段供诊断）。
 */
export async function queryVolcCloneStatus(
  provider: TtsProvider,
  speakerId: string,
  signal?: AbortSignal,
): Promise<{
  state: VolcCloneTrainState;
  raw?: number;
  trainingTimesLeft?: number | null;
}> {
  const { appId, accessToken } = cloneCredentials(provider);

  let v3Snippet = '';
  try {
    const { httpStatus, payload, rawText } = await postJson(
      VOLC_CLONE_STATUS_URL,
      buildVolcCloneHeaders(appId, accessToken, uuidv4()),
      { speaker_id: speakerId },
      30_000,
      signal,
    );
    v3Snippet = rawText.slice(0, 300);
    if (httpStatus < 400) {
      const parsed = parseVolcCloneStatus(payload);
      if (parsed.found) return parsed;
      logMessage(
        `volc clone status v3 no status field: ${v3Snippet}`,
        'warning',
      );
    } else {
      logMessage(
        `volc clone status v3 HTTP ${httpStatus}: ${v3Snippet}`,
        'warning',
      );
    }
  } catch (e) {
    logMessage(`volc clone status v3 failed: ${e}`, 'warning');
  }

  // V1 回退（实测可用形态）。
  const v1 = await postJson(
    VOLC_CLONE_STATUS_URL_V1,
    buildVolcCloneV1Headers(accessToken),
    { appid: appId, speaker_id: speakerId },
    30_000,
    signal,
  );
  if (v1.httpStatus >= 400) {
    throw new Error(
      volcCloneErrorHint(
        v1.httpStatus,
        extractErrorCode(v1.payload),
        extractErrorMessage(v1.payload, v1.rawText),
      ),
    );
  }
  const parsed = parseVolcCloneStatus(v1.payload);
  if (parsed.found) return parsed;
  throw new Error(
    `豆包声音复刻: 状态响应无法识别（V3: ${v3Snippet || 'n/a'} / V1: ${v1.rawText.slice(0, 300)}）`,
  );
}

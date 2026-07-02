/**
 * 火山引擎豆包「大模型录音文件识别·极速版」（`/api/v3/auc/bigmodel/recognize/flash`）的
 * 纯工具（无网络 / fs / electron），便于 test:engines 单测。
 *
 * 火山以自有状态码体系表意（响应头 `X-Api-Status-Code`，HTTP 可能恒 200），
 * 成败/重试判定必须读头部状态码，与既有三家「按 HTTP 状态判定」不同。
 */
import type { AsrSegment, AsrWord } from './types';

const VOLC_DEFAULT_BASE = 'https://openspeech.bytedance.com';
export const VOLC_FLASH_PATH = '/api/v3/auc/bigmodel/recognize/flash';
/** 极速版固定资源 ID（官方文档：需开通 volc.bigasr.auc_turbo 权限）。 */
export const VOLC_RESOURCE_ID = 'volc.bigasr.auc_turbo';

/**
 * 规范化 Base URL：空/非法 → 官方默认；去除误粘的 flash 路径后缀；去尾部斜杠。
 * base 非必填，缺省回落官方端点。
 */
export function normalizeVolcBaseURL(apiUrl?: string): string {
  const trimmed = apiUrl?.trim();
  if (!trimmed) return VOLC_DEFAULT_BASE;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return VOLC_DEFAULT_BASE;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return VOLC_DEFAULT_BASE;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname =
    normalizedPath.replace(
      /\/api\/v3\/auc\/bigmodel(\/recognize(\/flash)?)?$/i,
      '',
    ) || '/';
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

/**
 * 构造鉴权 header：新版语音控制台单 API Key（`X-Api-Key`）。
 * 注意：火山方舟 / 大模型推理的 API Key 与豆包语音不通用（会 401 Invalid X-Api-Key）。
 */
export function buildVolcHeaders(
  apiKey: unknown,
  requestId: string,
): Record<string, string> {
  return {
    'X-Api-Key': String(apiKey ?? '').trim(),
    'X-Api-Resource-Id': VOLC_RESOURCE_ID,
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
    'Content-Type': 'application/json',
  };
}

/**
 * 构造请求体：base64 直传（不提供 URL 模式，音频不出本机存储）。
 * 固定开启分句 + 逐字时间戳（show_utterances）与标点/ITN；关闭语义顺滑（ddc）保字幕保真。
 * `user.uid` 为必填的任意调用方标识，固定应用名即可。
 */
export function buildVolcRequestBody(
  base64Data: string,
  model: string,
): Record<string, unknown> {
  return {
    user: { uid: 'video-subtitle-master' },
    audio: { data: base64Data },
    request: {
      model_name: model || 'bigmodel',
      enable_punc: true,
      enable_itn: true,
      enable_ddc: false,
      show_utterances: true,
    },
  };
}

/**
 * 状态分类（官方错误码表）：
 * - success：`20000000`
 * - empty：`20000003` 静音音频 → 空结果成功（与本地引擎「无人声→空字幕」语义一致）
 * - auth：HTTP 401/403（凭据无效/无权限）→ 不重试
 * - retriable：`55000031` 过载、`550xxxxx` 服务内部错、HTTP 429/5xx
 * - fatal：`45xxxxxx` 参数/空音频/格式错、其余未知 → 不重试、明确报错
 */
export type VolcStatusClass =
  | 'success'
  | 'empty'
  | 'auth'
  | 'retriable'
  | 'fatal';

export function classifyVolcStatus(
  httpStatus: number,
  apiStatusCode?: string | null,
): VolcStatusClass {
  const code = String(apiStatusCode ?? '').trim();
  if (code === '20000000') return 'success';
  if (code === '20000003') return 'empty';
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (code === '55000031' || /^550/.test(code)) return 'retriable';
  if (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) {
    return 'retriable';
  }
  return 'fatal';
}

/**
 * 生成静音 WAV（16-bit PCM 单声道）的 base64，供连接自测作最小合法音频探测。
 * 实测（2026-07）服务端参数校验先于鉴权——空 audio.data 会在鉴权前被参数错误拒掉，
 * 任意假 key 也「测试通过」；探测必须携带合法音频才能真正走到鉴权：
 * 有效凭据 → 20000000/20000003（静音空结果）；无效凭据 → HTTP 401 Invalid X-Api-Key / 403。
 */
export function buildSilentWavBase64(seconds = 1, sampleRate = 16000): string {
  const numSamples = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize); // 数据区全零 = 静音
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf.toString('base64');
}

/** 火山 utterance/word 均为毫秒；换算秒并过滤非有限值。 */
function msToSec(value: unknown): number {
  return Number(value) / 1000;
}

/**
 * 从极速版响应体提取 { text, words, segments }：
 * - `result.text`：整段带标点文本（供词级路径做标点回贴）；
 * - `result.utterances[].words[]`（逐字、无标点、毫秒）拍平 → AsrWord（秒）；
 * - `result.utterances[]`（分句、带标点、毫秒）→ AsrSegment（秒），作缺词级时的段级兜底。
 */
export function extractVolcResult(data: unknown): {
  text: string;
  words: AsrWord[];
  segments: AsrSegment[];
} {
  const result = (data as { result?: Record<string, unknown> })?.result;
  const text = String((result as { text?: unknown })?.text ?? '');
  const utterances = (result as { utterances?: unknown })?.utterances;
  const words: AsrWord[] = [];
  const segments: AsrSegment[] = [];
  if (Array.isArray(utterances)) {
    for (const u of utterances) {
      const uStart = msToSec((u as { start_time?: unknown })?.start_time);
      const uEnd = msToSec((u as { end_time?: unknown })?.end_time);
      const uText = String((u as { text?: unknown })?.text ?? '').trim();
      if (Number.isFinite(uStart) && Number.isFinite(uEnd) && uText) {
        segments.push({ start: uStart, end: uEnd, text: uText });
      }
      const uWords = (u as { words?: unknown })?.words;
      if (!Array.isArray(uWords)) continue;
      for (const w of uWords) {
        const word = String((w as { text?: unknown })?.text ?? '').trim();
        if (!word) continue;
        const start = msToSec((w as { start_time?: unknown })?.start_time);
        const end = msToSec((w as { end_time?: unknown })?.end_time);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          words.push({ word, start, end });
        }
      }
    }
  }
  return { text, words, segments };
}

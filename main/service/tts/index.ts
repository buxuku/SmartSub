import {
  TTS_AZURE_SPEECH,
  TTS_EDGE,
  TTS_ELEVENLABS,
  TTS_OPENAI_COMPATIBLE,
  TTS_VOLCENGINE,
  getTtsCapabilities,
  parseTtsVoices,
  type TtsProvider,
  type TtsSegmentRequest,
} from '../../../types/ttsProvider';
import { synthesizeWithOpenAiCompatible } from './openaiCompatible';
import { synthesizeWithEdge } from './edge';
import { synthesizeWithAzure } from './azure';
import { synthesizeWithElevenLabs } from './elevenlabs';
import { synthesizeWithVolcengine } from './volcengine';
import type { TtsSynthesizer, TtsSynthesizeResult } from './types';

/**
 * 云 TTS service 分发表：按 provider.type 路由到具体实现（对齐 ASR_TRANSCRIBER_MAP）。
 * 新增一家服务商 = 加一条映射 + 一个 synthesize 实现。
 */
export const TTS_SYNTHESIZER_MAP: Record<string, TtsSynthesizer> = {
  [TTS_OPENAI_COMPATIBLE]: synthesizeWithOpenAiCompatible,
  [TTS_EDGE]: synthesizeWithEdge,
  [TTS_AZURE_SPEECH]: synthesizeWithAzure,
  [TTS_ELEVENLABS]: synthesizeWithElevenLabs,
  [TTS_VOLCENGINE]: synthesizeWithVolcengine,
};

export function getTtsSynthesizer(
  type: string | undefined,
): TtsSynthesizer | undefined {
  if (!type) return undefined;
  return TTS_SYNTHESIZER_MAP[type];
}

/**
 * 统一入口：发起前守卫（单请求字符上限，v1 不自动切分）+ 分发。
 * 并发闸由调用方（dubbingProcessor 经 cloudProviderGate）持有，这里不重复限流。
 */
export async function synthesizeSegment(
  provider: TtsProvider,
  request: TtsSegmentRequest,
): Promise<TtsSynthesizeResult> {
  const synthesizer = getTtsSynthesizer(provider.type);
  if (!synthesizer) {
    throw new Error(`Cloud TTS: unknown provider type '${provider.type}'`);
  }
  const caps = getTtsCapabilities(provider.type);
  if (
    caps.maxCharsPerRequest &&
    request.text.length > caps.maxCharsPerRequest
  ) {
    throw new Error(
      `单条文本超过该服务商单请求上限（${request.text.length} > ${caps.maxCharsPerRequest} 字符），请拆分该行字幕`,
    );
  }
  return synthesizer(provider, request);
}

/** 实例的默认试听/合成 voice：候选池首个。 */
export function defaultVoiceOf(provider: TtsProvider): string {
  return parseTtsVoices(provider)[0] ?? '';
}

export type { TtsSynthesizeResult } from './types';

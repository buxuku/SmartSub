import {
  ASR_ALIYUN,
  ASR_DEEPGRAM,
  ASR_ELEVENLABS,
  ASR_OPENAI_COMPATIBLE,
  ASR_TENCENT,
  ASR_VOLCENGINE,
  ASR_XFYUN,
} from '../../../types/asrProvider';
import { transcribeWithOpenAiCompatible } from './openaiCompatible';
import { transcribeWithElevenLabs } from './elevenlabs';
import { transcribeWithDeepgram } from './deepgram';
import { transcribeWithVolcengine } from './volcengine';
import { transcribeWithTencent } from './tencent';
import { transcribeWithAliyun } from './aliyun';
import { transcribeWithXfyun } from './xfyun';
import type { AsrTranscriber } from './types';

/**
 * 云 ASR service 分发表：按 provider.type 路由到具体实现（对齐翻译的 TRANSLATOR_MAP）。
 * 新增一家服务商 = 加一条映射 + 一个 transcribe 实现，云引擎适配器无需改动。
 */
export const ASR_TRANSCRIBER_MAP: Record<string, AsrTranscriber> = {
  [ASR_OPENAI_COMPATIBLE]: transcribeWithOpenAiCompatible,
  [ASR_ELEVENLABS]: transcribeWithElevenLabs,
  [ASR_DEEPGRAM]: transcribeWithDeepgram,
  [ASR_VOLCENGINE]: transcribeWithVolcengine,
  [ASR_TENCENT]: transcribeWithTencent,
  [ASR_ALIYUN]: transcribeWithAliyun,
  [ASR_XFYUN]: transcribeWithXfyun,
};

export function getAsrTranscriber(
  type: string | undefined,
): AsrTranscriber | undefined {
  if (!type) return undefined;
  return ASR_TRANSCRIBER_MAP[type];
}

export type { AsrTranscribeInput, AsrTranscribeResult } from './types';

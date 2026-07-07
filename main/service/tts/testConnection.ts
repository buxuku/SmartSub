import {
  TTS_OPENAI_COMPATIBLE,
  type TtsProvider,
} from '../../../types/ttsProvider';
import { testOpenAiCompatibleTts } from './openaiCompatible';
import type { TtsTestResult } from './types';

export async function testTtsConnection(
  provider: TtsProvider,
): Promise<TtsTestResult> {
  if (!provider?.type) return { ok: false, needsConfig: true };
  if (provider.type === TTS_OPENAI_COMPATIBLE) {
    return testOpenAiCompatibleTts(provider);
  }
  return { ok: false, detail: `Unknown TTS provider type: ${provider.type}` };
}

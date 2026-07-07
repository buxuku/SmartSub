import type { TtsProvider } from '../../../types/ttsProvider';
import { TTS_OPENAI_COMPATIBLE } from '../../../types/ttsProvider';
import { synthesizeWithOpenAiCompatibleTts } from './openaiCompatible';
import type { TtsSynthesizeInput } from './types';

export async function synthesizeCloudTts(
  provider: TtsProvider,
  input: TtsSynthesizeInput,
): Promise<void> {
  switch (provider.type) {
    case TTS_OPENAI_COMPATIBLE:
      return synthesizeWithOpenAiCompatibleTts(provider, input);
    default:
      throw new Error(`Unsupported cloud TTS type: ${provider.type}`);
  }
}

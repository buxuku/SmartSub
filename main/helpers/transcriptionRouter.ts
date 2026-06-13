import { getActiveEngineAdapter } from './engines/registry';
import type { TranscribeContext } from './engines/types';

export async function routeTranscription(
  ctx: TranscribeContext,
): Promise<string> {
  const adapter = getActiveEngineAdapter();
  const status = await adapter.isAvailable();
  if (status.state !== 'ready') {
    throw new Error(
      `${adapter.displayName} is not available: ${status.message || status.state}`,
    );
  }
  return adapter.transcribe(ctx);
}

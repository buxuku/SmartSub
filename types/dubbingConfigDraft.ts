import { z } from 'zod';
import { assertDubbingConfig } from './dubbing';

const preferencesSchema = z.object({
  engineKey: z.string(),
  language: z.string().optional(),
  voice: z.string(),
  globalSpeed: z.number().finite(),
  cloneQuality: z.enum(['standard', 'high']).optional(),
  localConcurrency: z.number().optional(),
  background: z.enum(['mute', 'duck']),
  output: z.enum(['replaceTrack', 'mixTrack', 'addTrack', 'audioOnly']),
  audioFormat: z.enum(['wav', 'mp3']),
  overflow: z.enum(['truncate', 'shift']),
  overlapMode: z.enum(['shift', 'mix']).optional(),
  exportShiftedSubtitle: z.boolean(),
});

export type PersistedDubbingConfig = z.infer<typeof preferencesSchema>;
export const DEFAULT_DUBBING_PREFERENCES: PersistedDubbingConfig = {
  engineKey: '',
  voice: '',
  globalSpeed: 1,
  cloneQuality: 'standard',
  localConcurrency: 1,
  background: 'mute',
  output: 'replaceTrack',
  audioFormat: 'wav',
  overflow: 'truncate',
  overlapMode: 'shift',
  exportShiftedSubtitle: false,
};

export function parseDubbingPreferences(
  value: unknown,
): PersistedDubbingConfig {
  const next = preferencesSchema.parse(value);
  const engine = next.engineKey.startsWith('local:')
    ? { kind: 'local' as const, modelId: next.engineKey.slice(6) }
    : next.engineKey.startsWith('cloud:')
      ? { kind: 'cloud' as const, providerId: next.engineKey.slice(6) }
      : next.engineKey
        ? null
        : { kind: 'cloud' as const, providerId: 'default' };
  assertDubbingConfig({ ...next, engine, voice: next.voice || 'default' });
  return next;
}

const schema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().default(0),
  sessionId: z.string().min(1),
  saved: preferencesSchema,
  current: preferencesSchema,
});
export type DubbingConfigDraft = z.infer<typeof schema>;

export function parseDubbingConfigDraft(
  raw: string,
  sessionId: string,
): DubbingConfigDraft {
  const draft = schema.parse(JSON.parse(raw));
  if (draft.sessionId !== sessionId)
    throw new Error('Dubbing draft belongs to another project');
  return {
    ...draft,
    saved: parseDubbingPreferences(draft.saved),
    current: parseDubbingPreferences(draft.current),
  };
}

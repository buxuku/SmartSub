export type TranscriptionProviderId =
  | 'builtin-whisper'
  | 'local-whisper-command'
  | 'openrouter';

export type TranscriptionProviderKind = 'local' | 'api';

export type TranscriptionModelKind = 'whisper' | 'openrouter';

export interface TranscriptionProviderOption {
  id: TranscriptionProviderId;
  name: string;
  kind: TranscriptionProviderKind;
  requiresApiKey?: boolean;
  requiresDownload?: boolean;
  modelKind: TranscriptionModelKind;
}

export interface TranscriptionModelOption {
  id: string;
  name: string;
  provider: TranscriptionProviderId;
  kind: TranscriptionModelKind;
  size?: string;
  description?: string;
  needsCoreML?: boolean;
  downloadable?: boolean;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments?: TranscriptionSegment[];
}

export const DEFAULT_TRANSCRIPTION_PROVIDER: TranscriptionProviderId =
  'builtin-whisper';

export const OPENROUTER_GPT4O_TRANSCRIBE_MODEL = 'openai/gpt-4o-transcribe';

export const transcriptionProviders: TranscriptionProviderOption[] = [
  {
    id: 'builtin-whisper',
    name: 'Built-in Whisper',
    kind: 'local',
    requiresDownload: true,
    modelKind: 'whisper',
  },
  {
    id: 'local-whisper-command',
    name: 'Local Whisper Command',
    kind: 'local',
    modelKind: 'whisper',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter STT',
    kind: 'api',
    requiresApiKey: true,
    modelKind: 'openrouter',
  },
];

export const apiTranscriptionModels: TranscriptionModelOption[] = [
  {
    id: OPENROUTER_GPT4O_TRANSCRIBE_MODEL,
    name: 'OpenAI GPT-4o Transcribe',
    provider: 'openrouter',
    kind: 'openrouter',
    description: 'OpenRouter speech-to-text model openai/gpt-4o-transcribe',
  },
];

export function normalizeTranscriptionProvider(
  provider: unknown,
): TranscriptionProviderId {
  const providerId = String(provider || '');
  return transcriptionProviders.some((item) => item.id === providerId)
    ? (providerId as TranscriptionProviderId)
    : DEFAULT_TRANSCRIPTION_PROVIDER;
}

export function resetRemovedTranscriptionModel(
  model: unknown,
  fallbackModel = 'tiny',
): string {
  const modelId = String(model || '').trim();
  if (!modelId) return fallbackModel;

  if (/speech-k2/i.test(modelId)) {
    return fallbackModel;
  }

  return modelId;
}

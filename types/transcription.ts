export type TranscriptionProviderId =
  | 'builtin-whisper'
  | 'local-whisper-command'
  | 'openrouter'
  | 'reazonspeech-k2';

export type TranscriptionProviderKind = 'local' | 'api';

export type TranscriptionModelKind = 'whisper' | 'openrouter' | 'reazonspeech';

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

export const REAZON_SPEECH_K2_V2_MODEL = 'reazonspeech-k2-v2';

export const REAZON_SPEECH_K2_V2_FILES = [
  'decoder-epoch-99-avg-1.int8.onnx',
  'decoder-epoch-99-avg-1.onnx',
  'encoder-epoch-99-avg-1.int8.onnx',
  'encoder-epoch-99-avg-1.onnx',
  'joiner-epoch-99-avg-1.int8.onnx',
  'joiner-epoch-99-avg-1.onnx',
  'tokens.txt',
];

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
  {
    id: 'reazonspeech-k2',
    name: 'ReazonSpeech K2',
    kind: 'local',
    requiresDownload: true,
    modelKind: 'reazonspeech',
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

export const reazonSpeechModels: TranscriptionModelOption[] = [
  {
    id: REAZON_SPEECH_K2_V2_MODEL,
    name: 'ReazonSpeech K2 v2',
    provider: 'reazonspeech-k2',
    kind: 'reazonspeech',
    size: '775 MB',
    downloadable: true,
    description: 'Japanese ASR model based on ReazonSpeech K2 v2',
  },
];

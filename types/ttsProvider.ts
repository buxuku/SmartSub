import type { ProviderField } from './provider';

/** 云端 TTS 服务商类型 id。 */
export const TTS_OPENAI_COMPATIBLE = 'openaiCompatible';

export type TtsProviderField = ProviderField;

export type TtsProviderType = {
  id: string;
  name: string;
  shortName?: string;
  fields: TtsProviderField[];
  isBuiltin?: boolean;
  icon?: string;
  multiInstance?: boolean;
};

/** 用户配置的 TTS 服务商实例。 */
export type TtsProvider = {
  id: string;
  name: string;
  type: string;
  presetId?: string;
  [key: string]: unknown;
};

export type TtsProviderPreset = {
  id: string;
  name: string;
  values: Record<string, string | number | boolean>;
};

export const TTS_PROVIDER_TYPES: TtsProviderType[] = [
  {
    id: TTS_OPENAI_COMPATIBLE,
    name: 'OpenAI Compatible',
    isBuiltin: true,
    icon: '🔊',
    multiInstance: true,
    fields: [
      {
        key: 'apiUrl',
        label: 'Base url',
        type: 'url',
        required: true,
        defaultValue: 'https://api.openai.com/v1',
        tips: 'ttsApiUrlTips',
        placeholder: 'https://api.openai.com/v1',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        tips: 'ttsApiKeyTips',
        placeholder: 'phTtsApiKey',
      },
      {
        key: 'model',
        label: 'ttsModel',
        type: 'text',
        required: true,
        defaultValue: 'tts-1',
        tips: 'ttsModelFieldTips',
      },
      {
        key: 'voice',
        label: 'ttsVoice',
        type: 'text',
        required: true,
        defaultValue: 'alloy',
        tips: 'ttsVoiceFieldTips',
      },
      {
        key: 'responseFormat',
        label: 'ttsResponseFormat',
        type: 'select',
        required: false,
        defaultValue: 'wav',
        options: ['wav', 'mp3'],
        tips: 'ttsResponseFormatTips',
      },
      {
        key: 'requestTimeoutSec',
        label: 'ttsRequestTimeout',
        type: 'number',
        required: false,
        defaultValue: 60,
        step: 10,
        tips: 'ttsRequestTimeoutTips',
      },
      {
        key: 'maxRetries',
        label: 'ttsMaxRetries',
        type: 'number',
        required: false,
        defaultValue: 2,
        step: 1,
        tips: 'ttsMaxRetriesTips',
      },
    ],
  },
];

export const TTS_PRESETS: Record<string, TtsProviderPreset[]> = {
  [TTS_OPENAI_COMPATIBLE]: [
    {
      id: 'openai',
      name: 'OpenAI',
      values: {
        apiUrl: 'https://api.openai.com/v1',
        model: 'tts-1',
        voice: 'alloy',
      },
    },
  ],
};

export function getTtsProviderType(id: string): TtsProviderType | undefined {
  return TTS_PROVIDER_TYPES.find((t) => t.id === id);
}

export function getTtsPresetsForType(typeId: string): TtsProviderPreset[] {
  return TTS_PRESETS[typeId] ?? [];
}

export function buildTtsInstanceFromPreset(
  type: TtsProviderType,
  preset?: TtsProviderPreset,
  idFactory: () => string = () => `tts_${Date.now()}`,
): TtsProvider {
  const instance: TtsProvider = {
    id: idFactory(),
    name: preset?.name ?? type.name,
    type: type.id,
  };
  for (const f of type.fields) {
    if (f.defaultValue !== undefined) instance[f.key] = f.defaultValue;
  }
  if (preset) {
    Object.entries(preset.values).forEach(([k, v]) => {
      instance[k] = v;
    });
  }
  return instance;
}

export function nextTtsInstanceName(
  existing: Pick<TtsProvider, 'name'>[] | undefined,
  base: string,
): string {
  const names = new Set((existing ?? []).map((p) => p.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function isTtsProviderConfigured(
  provider: TtsProvider | undefined,
  type?: TtsProviderType,
): boolean {
  if (!provider) return false;
  const def = type ?? getTtsProviderType(provider.type);
  if (!def) return false;
  return def.fields
    .filter((f) => f.required)
    .every((f) => {
      const v = provider[f.key];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
}

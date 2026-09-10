export const PARAKEET_MODEL_IDS = [
  'parakeet-tdt-0.6b-v3',
  'parakeet-tdt-0.6b-v2',
  'parakeet-tdt_ctc-0.6b-ja',
] as const;

export type ParakeetModelId = (typeof PARAKEET_MODEL_IDS)[number];
export const PARAKEET_DEFAULT_MODEL_ID: ParakeetModelId =
  'parakeet-tdt-0.6b-v3';

export interface ParakeetModelDefinition {
  modelType: 'nemo_transducer' | 'nemo_ctc';
  languages: readonly string[];
  license: 'CC-BY-4.0';
  supportsPunctuation: boolean;
}

export const PARAKEET_MODEL_DEFINITIONS: Record<
  ParakeetModelId,
  ParakeetModelDefinition
> = {
  'parakeet-tdt-0.6b-v3': {
    modelType: 'nemo_transducer',
    languages: [
      'bg',
      'hr',
      'cs',
      'da',
      'nl',
      'en',
      'et',
      'fi',
      'fr',
      'de',
      'el',
      'hu',
      'it',
      'lv',
      'lt',
      'mt',
      'pl',
      'pt',
      'ro',
      'sk',
      'sl',
      'es',
      'sv',
      'ru',
      'uk',
    ],
    license: 'CC-BY-4.0',
    supportsPunctuation: true,
  },
  'parakeet-tdt-0.6b-v2': {
    modelType: 'nemo_transducer',
    languages: ['en'],
    license: 'CC-BY-4.0',
    supportsPunctuation: true,
  },
  'parakeet-tdt_ctc-0.6b-ja': {
    modelType: 'nemo_ctc',
    languages: ['ja'],
    license: 'CC-BY-4.0',
    supportsPunctuation: true,
  },
};

export function getParakeetModelId(
  value?: string,
): ParakeetModelId | undefined {
  const normalized = value?.trim().toLowerCase();
  return PARAKEET_MODEL_IDS.find((id) => id === normalized);
}

/** An explicit choice must never fall back to a different language model. */
export function resolveParakeetSelection(
  requested: string | undefined,
  installed: readonly string[],
): { id: ParakeetModelId } | null {
  const id = requested?.trim()
    ? getParakeetModelId(requested)
    : PARAKEET_DEFAULT_MODEL_ID;
  return id && installed.includes(id) ? { id } : null;
}

export function isParakeetLanguageMismatch(
  model: string | undefined,
  language: string | undefined,
): boolean {
  const id = getParakeetModelId(model);
  const base = language?.trim().toLowerCase().split(/[-_]/)[0];
  if (!id || !base || base === 'auto') return false;
  return !PARAKEET_MODEL_DEFINITIONS[id].languages.includes(base);
}

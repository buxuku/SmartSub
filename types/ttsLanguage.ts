/** Language tags are kept intact until an engine maps them to its own locale. */
export function normalizeTtsLanguage(value?: string): string | undefined {
  if (!value?.trim() || value.trim().toLowerCase() === 'auto') return undefined;
  const aliases: Record<string, string> = {
    chs: 'zh-Hans',
    cht: 'zh-Hant',
    cn: 'zh',
    eng: 'en',
    jpn: 'ja',
  };
  const tag = value.trim().replace(/_/g, '-');
  try {
    return Intl.getCanonicalLocales(aliases[tag.toLowerCase()] || tag)[0];
  } catch {
    return undefined;
  }
}

export function ttsBaseLanguage(value?: string): string | undefined {
  return normalizeTtsLanguage(value)?.split('-')[0];
}

export function resolveTtsLanguage(context: {
  language?: string;
  subtitleLanguage?: string;
  detectedLanguage?: string;
  voiceLanguage?: string;
}): string | undefined {
  return (
    normalizeTtsLanguage(context.language) ??
    normalizeTtsLanguage(context.subtitleLanguage) ??
    normalizeTtsLanguage(context.detectedLanguage) ??
    normalizeTtsLanguage(context.voiceLanguage)
  );
}

/** These models are bilingual/monolingual regardless of the selected speaker. */
export function localTtsLanguageError(
  modelId: string,
  language?: string,
): string | undefined {
  const supported =
    modelId === 'vits-zh-aishell3'
      ? ['zh']
      : ['kokoro-multi-lang-v1_1', 'zipvoice-distill-zh-en'].includes(modelId)
        ? ['zh', 'en']
        : undefined;
  const base = ttsBaseLanguage(language);
  if (base && supported && !supported.includes(base)) return language;
  return undefined;
}

/** Bump when local pronunciation changes; existing WAVs must not bypass new rules. */
export const TTS_TEXT_RULES_VERSION = 2;

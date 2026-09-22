export type TtsVoiceGender = 'female' | 'male' | 'child';
export interface TtsVoiceMetadata {
  lang?: string;
  gender?: TtsVoiceGender;
  styles?: string[];
}
export interface TtsVoiceEntry extends TtsVoiceMetadata {
  id: string;
  name: string;
}

const STYLE_ALIASES: Record<string, string> = {
  newscast: 'news',
  'newscast-casual': 'news',
  'newscast-formal': 'news',
  news: 'news',
  narration: 'story',
  'narration-professional': 'story',
  'narration-relaxed': 'story',
  storytelling: 'story',
  story: 'story',
  commentary: 'commentary',
  sports: 'commentary',
  'sports-commentary': 'commentary',
  anime: 'anime',
  animation: 'anime',
  characters: 'anime',
};

/** Only normalize declared metadata. Voice names are not evidence of gender/style. */
export function normalizeTtsVoiceMetadata(raw: unknown): TtsVoiceMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const result: TtsVoiceMetadata = {};
  if (typeof value.lang === 'string') {
    try {
      result.lang = Intl.getCanonicalLocales(value.lang.replace(/_/g, '-'))[0];
    } catch {
      /* unknown locale */
    }
  }
  const gender =
    typeof value.gender === 'string' ? value.gender.toLowerCase() : '';
  if (gender === 'f' || gender === 'female') result.gender = 'female';
  if (gender === 'm' || gender === 'male') result.gender = 'male';
  if (gender === 'child') result.gender = 'child';
  if (Array.isArray(value.styles)) {
    const styles = value.styles
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => /^[a-z][a-z0-9_-]{0,63}$/.test(entry))
      .map((entry) => STYLE_ALIASES[entry] || entry);
    if (styles.length) result.styles = Array.from(new Set(styles)).slice(0, 32);
  }
  return result;
}

export function parseTtsVoiceMetadata(
  raw: unknown,
): Record<string, TtsVoiceMetadata> {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).map(([id, metadata]) => [
        id,
        normalizeTtsVoiceMetadata(metadata),
      ]),
    );
  } catch {
    return {};
  }
}

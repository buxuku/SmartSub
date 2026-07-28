/**
 * User-defined language metadata shared by the renderer and main process.
 *
 * A custom language is intentionally just a display name plus a language code.
 * The code is passed through to transcription/translation providers unchanged;
 * provider support still depends on the selected engine/service.
 */
export interface CustomLanguage {
  name: string;
  value: string;
}

export interface LanguageOption extends CustomLanguage {
  isCustom: boolean;
}

export type CustomLanguageValidationError =
  | 'nameRequired'
  | 'invalidName'
  | 'codeRequired'
  | 'invalidCode'
  | 'duplicateCode'
  | 'builtInCode';

export const CUSTOM_LANGUAGE_NAME_MAX_LENGTH = 64;
export const CUSTOM_LANGUAGE_CODE_MAX_LENGTH = 35;
export const CUSTOM_LANGUAGE_LIMIT = 100;

// Accept BCP-47-style tags and the underscore form used by a few APIs.
// Examples: ug, en-GB, zh-Hant, sr_Latn.
const LANGUAGE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;
// `auto` is a synthetic source-language option, not a provider language code.
// Reserving it also prevents the target-language select from exposing an
// invalid automatic-detection value through a custom entry.
const RESERVED_LANGUAGE_CODE_KEYS = new Set(['auto']);

function normalizedCode(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function codeKey(value: string): string {
  return value.toLowerCase();
}

export function validateCustomLanguage(
  candidate: Partial<CustomLanguage>,
  options?: {
    builtInCodes?: Iterable<string>;
    existingCustomLanguages?: CustomLanguage[];
  },
): CustomLanguageValidationError | null {
  const name = normalizedName(candidate.name);
  const value = normalizedCode(candidate.value);
  if (!name) return 'nameRequired';
  if (!value) return 'codeRequired';
  if (name.length > CUSTOM_LANGUAGE_NAME_MAX_LENGTH) return 'invalidName';
  if (
    value.length > CUSTOM_LANGUAGE_CODE_MAX_LENGTH ||
    !LANGUAGE_CODE_PATTERN.test(value)
  ) {
    return 'invalidCode';
  }

  const key = codeKey(value);
  if (RESERVED_LANGUAGE_CODE_KEYS.has(key)) return 'builtInCode';
  const builtInCodes = new Set(
    Array.from(options?.builtInCodes ?? [], (code) => codeKey(code)),
  );
  if (builtInCodes.has(key)) return 'builtInCode';

  if (
    (options?.existingCustomLanguages ?? []).some(
      (language) => codeKey(language.value) === key,
    )
  ) {
    return 'duplicateCode';
  }
  return null;
}

/**
 * Sanitize persisted/imported data and make code uniqueness deterministic.
 * Invalid rows, built-in collisions and later duplicates are discarded.
 */
export function sanitizeCustomLanguages(
  input: unknown,
  builtInCodes: Iterable<string> = [],
): CustomLanguage[] {
  if (!Array.isArray(input)) return [];

  const result: CustomLanguage[] = [];
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') continue;
    const language = candidate as Partial<CustomLanguage>;
    const error = validateCustomLanguage(language, {
      builtInCodes,
      existingCustomLanguages: result,
    });
    if (error) continue;
    result.push({
      name: normalizedName(language.name),
      value: normalizedCode(language.value),
    });
    if (result.length >= CUSTOM_LANGUAGE_LIMIT) break;
  }
  return result;
}

export function mergeLanguageOptions(
  builtInLanguages: Array<{ name: string; value: string }>,
  customLanguages: unknown,
): LanguageOption[] {
  const custom = sanitizeCustomLanguages(
    customLanguages,
    builtInLanguages.map((language) => language.value),
  );
  return [
    ...builtInLanguages.map((language) => ({
      name: language.name,
      value: language.value,
      isCustom: false,
    })),
    ...custom.map((language) => ({ ...language, isCustom: true })),
  ];
}

export function getCustomLanguageName(
  code: string,
  customLanguages: unknown,
): string | undefined {
  const key = codeKey(normalizedCode(code));
  if (!key || !Array.isArray(customLanguages)) return undefined;
  const match = customLanguages.find(
    (candidate): candidate is CustomLanguage =>
      !!candidate &&
      typeof candidate === 'object' &&
      typeof candidate.value === 'string' &&
      typeof candidate.name === 'string' &&
      codeKey(candidate.value.trim()) === key,
  );
  return match?.name.trim() || undefined;
}

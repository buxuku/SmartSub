/**
 * 检测 AI 是否把原文直接当作译文返回。
 *
 * 这是保守的启发式：按语言方向、文字系统和内容形态区分强弱证据，
 * 避免把同文字系统的合理近似翻译或无需翻译的内容误送去补翻。
 */

import { normalizeForComparison, textSimilarity } from './similarity';

const LETTER = new RegExp('\\p{L}', 'gu');
const WORD = new RegExp('[\\p{L}\\p{M}][\\p{L}\\p{M}\\p{N}]*', 'gu');
const SUBTITLE_MARKUP = /<[^>\r\n]*>|\{\\[^}\r\n]*\}/g;
const URL_OR_EMAIL =
  /(?:https?|ftp):\/\/[^\s<]+|www\.[^\s<]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<]*)?/gi;

/** 近似复制判定要求的最少字母数；精确跨文字复制使用更低阈值。 */
export const UNTRANSLATED_MIN_LETTERS = 8;
/** 批次证据升级时仍要求至少两个字母，单字符感叹词不升级。 */
export const BATCH_COPY_MIN_LETTERS = 2;
/** 近似（而非完全相同）需要更多文本证据。 */
export const UNTRANSLATED_NEAR_COPY_MIN_LENGTH = 12;
export const UNTRANSLATED_SIMILARITY_THRESHOLD = 0.9;

const LANGUAGE_ALIASES: Record<string, string> = {
  cn: 'zh',
  jp: 'ja',
  kr: 'ko',
  iw: 'he',
  in: 'id',
  nb: 'no',
  nn: 'no',
};

const UNKNOWN_LANGUAGE_CODES = new Set([
  'auto',
  'automatic',
  'detect',
  'unknown',
  'und',
]);

type ScriptFamily =
  | 'latin'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'cyrillic'
  | 'greek'
  | 'arabic'
  | 'hebrew'
  | 'devanagari'
  | 'thai'
  | 'tamil';

const SCRIPT_PATTERNS: Array<[ScriptFamily, RegExp]> = [
  ['latin', new RegExp('\\p{Script=Latin}', 'gu')],
  ['han', new RegExp('\\p{Script=Han}', 'gu')],
  ['kana', new RegExp('[\\p{Script=Hiragana}\\p{Script=Katakana}]', 'gu')],
  ['hangul', new RegExp('\\p{Script=Hangul}', 'gu')],
  ['cyrillic', new RegExp('\\p{Script=Cyrillic}', 'gu')],
  ['greek', new RegExp('\\p{Script=Greek}', 'gu')],
  ['arabic', new RegExp('\\p{Script=Arabic}', 'gu')],
  ['hebrew', new RegExp('\\p{Script=Hebrew}', 'gu')],
  ['devanagari', new RegExp('\\p{Script=Devanagari}', 'gu')],
  ['thai', new RegExp('\\p{Script=Thai}', 'gu')],
  ['tamil', new RegExp('\\p{Script=Tamil}', 'gu')],
];

const LATIN_LANGUAGES = new Set([
  'en',
  'fr',
  'de',
  'es',
  'pt',
  'it',
  'nl',
  'pl',
  'tr',
  'sv',
  'cs',
  'da',
  'fi',
  'hu',
  'no',
  'ro',
  'sk',
  'hr',
  'sl',
  'et',
  'lv',
  'lt',
  'vi',
  'id',
  'ms',
]);

function normalizeLanguageCode(code?: string): string | undefined {
  const normalized = (code || '').trim().toLowerCase().replace(/_/g, '-');
  if (!normalized || UNKNOWN_LANGUAGE_CODES.has(normalized)) return undefined;
  const primary = normalized.split('-')[0];
  return LANGUAGE_ALIASES[primary] || primary;
}

function expectedScripts(language?: string): ScriptFamily[] | undefined {
  const languageCode = normalizeLanguageCode(language);
  if (!languageCode) return undefined;
  if (LATIN_LANGUAGES.has(languageCode)) return ['latin'];
  if (languageCode === 'zh') return ['han'];
  if (languageCode === 'ja') return ['han', 'kana'];
  if (languageCode === 'ko') return ['hangul'];
  if (['ru', 'uk', 'bg'].includes(languageCode)) return ['cyrillic'];
  // Serbian is commonly written in both Cyrillic and Latin. Treat either as
  // target-compatible so Croatian → Serbian unchanged names/text are not hard failures.
  if (languageCode === 'sr') return ['cyrillic', 'latin'];
  if (languageCode === 'el') return ['greek'];
  if (['ar', 'fa', 'ur'].includes(languageCode)) return ['arabic'];
  if (languageCode === 'he') return ['hebrew'];
  if (['hi', 'mr'].includes(languageCode)) return ['devanagari'];
  if (languageCode === 'th') return ['thai'];
  if (languageCode === 'ta') return ['tamil'];
  return undefined;
}

function stripNonLinguisticContent(text: string): string {
  return (text || '')
    .normalize('NFKC')
    .replace(SUBTITLE_MARKUP, ' ')
    .replace(URL_OR_EMAIL, ' ')
    .trim();
}

function dominantScript(text: string): ScriptFamily | undefined {
  let dominant: ScriptFamily | undefined;
  let dominantCount = 0;
  let tied = false;

  for (const [script, pattern] of SCRIPT_PATTERNS) {
    const count = (text.match(pattern) || []).length;
    if (count > dominantCount) {
      dominant = script;
      dominantCount = count;
      tied = false;
    } else if (count > 0 && count === dominantCount) {
      tied = true;
    }
  }

  return dominantCount > 0 && !tied ? dominant : undefined;
}

function sourceScriptDiffersFromTarget(
  source: string,
  targetLanguage?: string,
): boolean {
  const sourceScript = dominantScript(source);
  const targetScripts = expectedScripts(targetLanguage);
  return Boolean(
    sourceScript && targetScripts && !targetScripts.includes(sourceScript),
  );
}

function isCasedLetter(character: string): boolean {
  return character.toLowerCase() !== character.toUpperCase();
}

function isUppercaseLetter(character: string): boolean {
  return isCasedLetter(character) && character === character.toUpperCase();
}

/**
 * 识别可能是专名或标题式文本（OpenAI、Harry Potter、NASA Apollo）。
 * 这里只把它从“单条强证据”降为批次弱证据；批次复制证据充分时仍可升级，
 * 避免标题式或全大写普通句被永久豁免。
 */
function looksLikeProperName(text: string): boolean {
  const words = text.match(WORD) || [];
  if (words.length === 0 || words.length > 5) return false;

  return words.every((word) => {
    const casedLetters = Array.from(word).filter(isCasedLetter);
    if (casedLetters.length === 0) return false;

    const firstIsUppercase = isUppercaseLetter(casedLetters[0]);
    const hasUppercase = casedLetters.some(isUppercaseLetter);
    const hasLowercase = casedLetters.some(
      (character) => !isUppercaseLetter(character),
    );

    return (
      firstIsUppercase ||
      (hasUppercase && hasLowercase) ||
      casedLetters.every(isUppercaseLetter)
    );
  });
}

function hasDifferentKnownLanguageDirection(
  sourceLanguage?: string,
  targetLanguage?: string,
): boolean {
  const targetCode = normalizeLanguageCode(targetLanguage);
  if (!targetCode) return false;
  const sourceCode = normalizeLanguageCode(sourceLanguage);
  return !sourceCode || sourceCode !== targetCode;
}

export type UntranslatedEvidenceStrength = 'none' | 'weak' | 'strong';

interface PreparedComparison {
  source: string;
  normalizedSource: string;
  normalizedTranslation: string;
  sourceLetterCount: number;
  crossScript: boolean;
}

function prepareComparison(
  sourceText: string,
  translatedText: string,
  sourceLanguage?: string,
  targetLanguage?: string,
): PreparedComparison | undefined {
  if (!hasDifferentKnownLanguageDirection(sourceLanguage, targetLanguage)) {
    return undefined;
  }

  const source = stripNonLinguisticContent(sourceText);
  const translated = stripNonLinguisticContent(translatedText);
  if (!source || !translated) return undefined;

  const normalizedSource = normalizeForComparison(source);
  const normalizedTranslation = normalizeForComparison(translated);
  if (!normalizedSource || !normalizedTranslation) return undefined;

  return {
    source,
    normalizedSource,
    normalizedTranslation,
    sourceLetterCount: (source.match(LETTER) || []).length,
    crossScript: sourceScriptDiffersFromTarget(source, targetLanguage),
  };
}

/**
 * 为“译文仍像原文”提供分级证据：
 * - strong：源文主文字系统与目标语言不兼容，且为精确复制或长近似复制；
 * - weak：同文字系统的精确/近似结果，或短标题式/疑似专名；
 * - none：目标语言不明确、源/目标同语言、非语言内容、单字符或相似度不足。
 *
 * 只有 strong 可单条送修。weak 仅供批次聚合观察；同文字系统的 weak
 * 不得单独触发补翻耗尽后的硬失败。
 */
export function classifyUntranslatedEvidence(
  sourceText: string,
  translatedText: string,
  sourceLanguage?: string,
  targetLanguage?: string,
): UntranslatedEvidenceStrength {
  const comparison = prepareComparison(
    sourceText,
    translatedText,
    sourceLanguage,
    targetLanguage,
  );
  if (!comparison) return 'none';

  const {
    source,
    normalizedSource,
    normalizedTranslation,
    sourceLetterCount,
    crossScript,
  } = comparison;
  const titleOrNameLike = looksLikeProperName(source);

  if (normalizedSource === normalizedTranslation) {
    if (sourceLetterCount < BATCH_COPY_MIN_LETTERS) return 'none';
    return crossScript && !titleOrNameLike ? 'strong' : 'weak';
  }

  if (
    sourceLetterCount < UNTRANSLATED_MIN_LETTERS ||
    Math.min(normalizedSource.length, normalizedTranslation.length) <
      UNTRANSLATED_NEAR_COPY_MIN_LENGTH ||
    textSimilarity(normalizedSource, normalizedTranslation) <
      UNTRANSLATED_SIMILARITY_THRESHOLD
  ) {
    return 'none';
  }

  return crossScript && !titleOrNameLike ? 'strong' : 'weak';
}

/**
 * 批次证据成立后可升级的“精确复制”候选。
 *
 * 与 isLikelyUntranslated 不同，这里还保留标题式/全大写/疑似专名作为弱候选，
 * 供同批的其他强证据升级；仍排除单字符、纯数字、URL/邮箱，以及本身已经
 * 使用目标文字系统的合理保留内容。该函数不能单独作为失败判定。
 */
export function isExactSourceCopyCandidate(
  sourceText: string,
  translatedText: string,
  sourceLanguage?: string,
  targetLanguage?: string,
): boolean {
  const comparison = prepareComparison(
    sourceText,
    translatedText,
    sourceLanguage,
    targetLanguage,
  );
  if (!comparison) return false;

  return Boolean(
    comparison.crossScript &&
      comparison.sourceLetterCount >= BATCH_COPY_MIN_LETTERS &&
      comparison.normalizedSource === comparison.normalizedTranslation,
  );
}

/**
 * 判断译文是否很可能只是原文回传。
 *
 * 目标语言缺失或源/目标语言代码相同时不判定，避免同语种润色、简繁转换等
 * 场景误报。源语言自动检测/未知时仍可依靠源文本文字系统与已知目标语言判定。
 */
export function isLikelyUntranslated(
  sourceText: string,
  translatedText: string,
  sourceLanguage?: string,
  targetLanguage?: string,
): boolean {
  return (
    classifyUntranslatedEvidence(
      sourceText,
      translatedText,
      sourceLanguage,
      targetLanguage,
    ) === 'strong'
  );
}

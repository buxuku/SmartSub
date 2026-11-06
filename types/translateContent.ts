/**
 * How a delivered subtitle file lays out its text (the "output style").
 *
 * Shared by the renderer, the main process and the automation layer, so this module
 * must stay free of any runtime dependency.
 */
export const TRANSLATE_CONTENT_VALUES = [
  'onlyTranslate',
  'sourceAndTranslate',
  'translateAndSource',
] as const;

export type TranslateContent = (typeof TRANSLATE_CONTENT_VALUES)[number];

/** Translation only, as before 3.9.0: bilingual lines are something a user opts into. */
export const DEFAULT_TRANSLATE_CONTENT: TranslateContent = 'onlyTranslate';

export function isTranslateContent(value: unknown): value is TranslateContent {
  return (
    typeof value === 'string' &&
    (TRANSLATE_CONTENT_VALUES as readonly string[]).includes(value)
  );
}

/** Anything that is not a known style means "not chosen"; it never implies bilingual. */
export function normalizeTranslateContent(value: unknown): TranslateContent {
  return isTranslateContent(value) ? value : DEFAULT_TRANSLATE_CONTENT;
}

/**
 * A task config reaches the translator from several entry points (the task page,
 * automation, the download pipeline, tasks queued by an older build). Fill a missing
 * or unknown style at the point of use. Tasks that never translate keep their
 * snapshot verbatim.
 */
export function withValidTranslateContent<T extends Record<string, any>>(
  config: T,
): T {
  if (
    config?.taskType === 'generateOnly' ||
    isTranslateContent(config?.translateContent)
  )
    return config;
  return { ...config, translateContent: DEFAULT_TRANSLATE_CONTENT };
}

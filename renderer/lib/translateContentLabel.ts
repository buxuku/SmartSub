import { normalizeTranslateContent } from '../../types/translateContent';

export type TranslateContentLabelKey =
  | 'outputTranslationOnly'
  | 'outputTranslationFirst'
  | 'outputSourceFirst';

/** `home` namespace key naming an output style; an unset style reads as the default. */
export function translateContentLabelKey(
  value: unknown,
): TranslateContentLabelKey {
  switch (normalizeTranslateContent(value)) {
    case 'translateAndSource':
      return 'outputTranslationFirst';
    case 'sourceAndTranslate':
      return 'outputSourceFirst';
    default:
      return 'outputTranslationOnly';
  }
}

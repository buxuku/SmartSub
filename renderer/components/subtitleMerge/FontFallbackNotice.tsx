import React from 'react';
import { useTranslation } from 'next-i18next';
import type { FontFallbackSummary } from '../../../types/subtitleMerge';

const MAX_FALLBACK_ROWS = 3;
const MAX_MISSING_CHARACTERS = 12;

/** Explains glyph fallbacks and characters that no installed font can draw. */
export default function FontFallbackNotice({
  report,
}: {
  report: FontFallbackSummary;
}) {
  const { t } = useTranslation('subtitleMerge');
  if (!report.fallbacks.length && !report.missingGlyphs.length) return null;
  const missing = report.missingGlyphs.slice(0, MAX_MISSING_CHARACTERS);
  return (
    <div
      role="status"
      data-font-fallback
      className="mb-2 shrink-0 space-y-1 rounded bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
    >
      {report.fallbacks.slice(0, MAX_FALLBACK_ROWS).map((fallback) => (
        <p key={`${fallback.from}>${fallback.to}`}>
          {t('fontFallbackNotice', {
            from: fallback.from,
            to: fallback.to,
            sample: fallback.sample,
          })}
        </p>
      ))}
      {missing.length > 0 && (
        <p data-font-missing-glyphs>
          {t('fontMissingGlyphs', {
            chars: missing.join(' '),
            more:
              report.missingGlyphs.length > missing.length
                ? ` +${report.missingGlyphs.length - missing.length}`
                : '',
          })}
        </p>
      )}
    </div>
  );
}

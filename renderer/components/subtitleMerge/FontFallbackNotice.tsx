import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import type { FontFallbackSummary } from '../../../types/subtitleMerge';

const MAX_FALLBACK_ROWS = 3;
const MAX_MISSING_CHARACTERS = 12;

interface Recommendation {
  name: string;
  displayName?: string;
}

/**
 * Explains glyph fallbacks and characters no installed font can draw, and
 * offers installed fonts that render the whole subtitle without any fallback.
 * Nothing is switched automatically: the user picks the font.
 */
export default function FontFallbackNotice({
  report,
  fontName,
  subtitlePath,
  sampleText,
  onSelectFont,
}: {
  report: FontFallbackSummary;
  fontName: string;
  subtitlePath?: string | null;
  sampleText?: string;
  onSelectFont?: (name: string) => void;
}) {
  const { t } = useTranslation('subtitleMerge');
  const affected =
    report.fallbacks.length > 0 || report.missingGlyphs.length > 0;
  const reportKey = JSON.stringify(report);
  const [recommended, setRecommended] = useState<Recommendation[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  useEffect(() => {
    setRecommended([]);
    setSearched(false);
    if (!affected) {
      setSearching(false);
      return;
    }
    let stale = false;
    setSearching(true);
    window.ipc
      .invoke('subtitleMerge:recommendFonts', {
        subtitlePath,
        sampleText,
        fontName,
      })
      .then(
        (result) => {
          if (stale) return;
          setSearching(false);
          setSearched(true);
          if (result?.success && Array.isArray(result.data?.fonts))
            setRecommended(result.data.fonts);
        },
        () => {
          if (stale) return;
          setSearching(false);
          setSearched(true);
        },
      );
    return () => {
      stale = true;
    };
  }, [affected, reportKey, fontName, subtitlePath, sampleText]);
  if (!affected) return null;
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
      {searching && <p>{t('fontRecommendLoading')}</p>}
      {searched && !recommended.length && missing.length > 0 && (
        <p data-font-install-hint>{t('fontInstallHint')}</p>
      )}
      {recommended.length > 0 && (
        <div
          data-font-recommendations
          className="flex flex-wrap items-center gap-1.5"
        >
          <span>{t('fontRecommendLabel')}</span>
          {recommended.map((font) => (
            <Button
              key={font.name}
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={!onSelectFont}
              title={font.displayName ? font.name : undefined}
              onClick={() => onSelectFont?.(font.name)}
            >
              {font.displayName || font.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

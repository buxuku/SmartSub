import React, { memo, useMemo, useId } from 'react';
import { useTranslation } from 'next-i18next';
import { AlertTriangle } from 'lucide-react';
import { subtitleHealth } from '../../lib/subtitleHealth';

export default memo(function SubtitleHealth({
  text,
  start,
  end,
  language,
  compact = false,
}: {
  text: string;
  start?: number;
  end?: number;
  language?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation('home');
  const warningId = useId();
  const health = useMemo(
    () => subtitleHealth(text, start, end, language),
    [text, start, end, language],
  );
  if (compact && !health.tooFast) return null;
  const warning = t('subtitleHealth.tooFast', { threshold: health.threshold });
  return (
    <span
      data-subtitle-health
      data-cps-warning={health.tooFast}
      className={`flex shrink-0 items-center gap-1 text-[10px] tabular-nums ${health.tooFast ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
    >
      {health.tooFast && (
        <span
          className="group relative"
          tabIndex={0}
          aria-label={warning}
          aria-describedby={warningId}
        >
          <AlertTriangle className="h-3 w-3" />
          <span
            id={warningId}
            role="tooltip"
            className={`pointer-events-none absolute ${compact ? 'right-0' : 'left-0'} top-full z-20 hidden w-56 rounded-md bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md group-hover:block group-focus:block`}
          >
            {warning}
          </span>
        </span>
      )}
      {!compact && (
        <span>
          {t('subtitleHealth.characters', { count: health.characters })} ·{' '}
        </span>
      )}
      <span>{health.cps === null ? '-' : health.cps.toFixed(1)} CPS</span>
      {!compact && (
        <span>
          {' '}
          · {t('subtitleHealth.lineLength', { count: health.longestLine })}
        </span>
      )}
    </span>
  );
});

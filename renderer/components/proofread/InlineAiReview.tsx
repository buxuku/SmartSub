import React, { useMemo } from 'react';
import { diffArrays } from 'diff';
import { useTranslation } from 'next-i18next';
import { Check, X, RotateCcw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { InlineAiSuggestion } from '../../lib/inlineAi';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const tokens = (text: string) =>
  Array.from(segmenter.segment(text), (item) => item.segment);

export default function InlineAiReview({
  suggestion,
  stale,
  onAccept,
  onDismiss,
  onRetry,
}: {
  suggestion: InlineAiSuggestion;
  stale: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation('home');
  const changes = useMemo(() => {
    const result = diffArrays(
      tokens(suggestion.original),
      tokens(suggestion.proposed || ''),
      { timeout: 30 },
    );
    return (
      result || [
        { value: [suggestion.original], removed: true, added: false },
        { value: [suggestion.proposed || ''], added: true, removed: false },
      ]
    );
  }, [suggestion.original, suggestion.proposed]);
  return (
    <section
      data-ai-review={suggestion.status}
      aria-label={t('aiOptimizedResult')}
      tabIndex={0}
      className="mt-2 min-w-0 space-y-2 bg-muted/40 p-2 outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey
        )
          return;
        if ((event.target as HTMLElement).closest('button')) return;
        if (event.key === 'Enter' && !stale && suggestion.status === 'ready') {
          event.preventDefault();
          event.stopPropagation();
          onAccept();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }
      }}
    >
      {suggestion.status === 'loading' ? (
        <p role="status" className="flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('optimizing')}
        </p>
      ) : (
        <>
          {suggestion.status === 'ready' && (
            <>
              <p
                className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                data-ai-diff="original"
              >
                <span className="text-muted-foreground">
                  {t('inlineAi.before')}:{' '}
                </span>
                {changes
                  .filter((part) => !part.added)
                  .map((part, i) =>
                    part.removed ? (
                      <del
                        key={i}
                        className="bg-red-500/15 text-red-700 dark:text-red-300"
                      >
                        {part.value.join('')}
                      </del>
                    ) : (
                      <span key={i}>{part.value.join('')}</span>
                    ),
                  )}
              </p>
              <p
                className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                data-ai-diff="proposed"
              >
                <span className="text-muted-foreground">
                  {t('inlineAi.proposed')}:{' '}
                </span>
                {changes
                  .filter((part) => !part.removed)
                  .map((part, i) =>
                    part.added ? (
                      <ins
                        key={i}
                        className="bg-emerald-500/15 text-emerald-700 no-underline dark:text-emerald-300"
                      >
                        {part.value.join('')}
                      </ins>
                    ) : (
                      <span key={i}>{part.value.join('')}</span>
                    ),
                  )}
              </p>
            </>
          )}
          {(stale || suggestion.error) && (
            <div role="alert" className="text-destructive">
              {stale ? t('inlineAi.stale') : t('aiOptimizeFailed')}
              {suggestion.error && (
                <details>
                  <summary>{t('inlineAi.details')}</summary>
                  <p className="break-words [overflow-wrap:anywhere]">
                    {suggestion.error}
                  </p>
                </details>
              )}
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-1">
        {suggestion.status === 'ready' && (
          <Button
            size="sm"
            className="h-7 gap-1"
            disabled={stale}
            onClick={onAccept}
          >
            <Check className="h-3 w-3" />
            {t('acceptOptimization')}
          </Button>
        )}
        {(stale || suggestion.status === 'error') && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1"
            onClick={onRetry}
          >
            <RotateCcw className="h-3 w-3" />
            {t('waveform.retry')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1"
          onClick={onDismiss}
        >
          <X className="h-3 w-3" />
          {t('inlineAi.ignore')}
        </Button>
      </div>
    </section>
  );
}

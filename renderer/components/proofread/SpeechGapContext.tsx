import React, { useMemo, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { AlertTriangle, ChevronDown, ChevronUp, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { QualityIssue } from '../../../types/qualityReview';
import type { Subtitle } from '../../hooks/useSubtitles';
import { qualityIssueContext } from '../../lib/qualityIssueContext';
import { speechRangeTime } from '../subtitle/MissedSpeechControls';

export default function SpeechGapContext({
  issue,
  rows,
  translation,
  onListen,
}: {
  issue: QualityIssue;
  rows: Subtitle[];
  translation: boolean;
  onListen?: (issue: QualityIssue) => void;
}) {
  const { t } = useTranslation('home');
  const q = (key: string) => t(`quality.${key}`);
  const [expanded, setExpanded] = useState(false);
  const neighbors = useMemo(
    () => qualityIssueContext(issue, rows),
    [issue.start, issue.end, rows],
  );
  const before = neighbors.before.slice(0, expanded ? 2 : 1).reverse();
  const after = neighbors.after.slice(0, expanded ? 2 : 1);
  const time = (seconds: number) => speechRangeTime(seconds * 1000);
  const renderNeighbors = (indices: number[], side: 'before' | 'after') => (
    <div className="space-y-2 px-3 py-2.5" data-quality-context-side={side}>
      <h5 className="font-medium text-muted-foreground">
        {q(`gapContext.${side}`)}
      </h5>
      {indices.length ? (
        indices.map((index) => {
          const row = rows[index];
          return (
            <div key={index} className="space-y-1">
              <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                <span>#{index + 1}</span>
                <span className="font-mono tabular-nums">
                  {time(row.startTimeInSeconds!)} –{' '}
                  {time(row.endTimeInSeconds!)}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {row.sourceContent || row.content.join('\n')}
              </p>
              {translation && row.targetContent && (
                <p className="whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">
                  {row.targetContent}
                </p>
              )}
            </div>
          );
        })
      ) : (
        <p className="text-muted-foreground">
          {q(`gapContext.no${side === 'before' ? 'Before' : 'After'}`)}
        </p>
      )}
    </div>
  );
  return (
    <section
      className="overflow-hidden rounded-lg border bg-card text-xs"
      aria-label={q('gapContext.title')}
      data-quality-gap-context
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-panel-2 px-3 py-2">
        <h4 className="font-semibold">{q('gapContext.title')}</h4>
        {onListen && (before.length > 0 || after.length > 0) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onListen({
                ...issue,
                start: before.length
                  ? Math.min(
                      issue.start,
                      ...before.map((i) => rows[i].startTimeInSeconds!),
                    )
                  : issue.start,
                end: after.length
                  ? Math.max(
                      issue.end,
                      ...after.map((i) => rows[i].endTimeInSeconds!),
                    )
                  : issue.end,
              })
            }
          >
            <Play className="h-3.5 w-3.5" />
            {q('gapContext.listen')}
          </Button>
        )}
      </div>
      {renderNeighbors(before, 'before')}
      <div
        className="flex items-start gap-2 border-y border-dashed border-warning/30 bg-warning/5 px-3 py-2.5"
        data-quality-gap-marker
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-warning">{q('gapContext.missing')}</p>
          <p className="font-mono tabular-nums text-muted-foreground">
            {time(issue.start)} – {time(issue.end)}
          </p>
        </div>
      </div>
      {renderNeighbors(after, 'after')}
      {(neighbors.before.length > 1 || neighbors.after.length > 1) && (
        <div className="border-t px-3 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {q(expanded ? 'gapContext.less' : 'gapContext.more')}
          </Button>
        </div>
      )}
    </section>
  );
}

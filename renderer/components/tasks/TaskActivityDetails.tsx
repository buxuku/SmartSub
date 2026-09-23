import React, { memo, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { ChevronDown } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { ActivityUnit, TaskActivity } from '../../../types/taskActivity';

const clockTime = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

/** A fixed-height latest-status line. Only phase changes animate; clocks stay local. */
export const TaskActivityDetails = memo(function TaskActivityDetails({
  activity,
  progress,
  state,
  stage,
  statusText,
  warning,
}: {
  activity?: TaskActivity;
  progress?: number;
  state?: string;
  stage?: string | null;
  statusText?: string;
  warning?: string;
}) {
  const { t } = useTranslation('tasks');
  const [now, setNow] = useState(Date.now);
  const active = Boolean(
    activity?.stage &&
      (stage === undefined || stage === activity.stage) &&
      (!state || state === 'running' || state === 'cancelling') &&
      (activity.status === 'running' || activity.status === 'cancelling'),
  );
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, activity?.run]);

  const translating = activity?.stage === 'translateSubtitle';
  const phaseLabel = (phase: string) => {
    if (phase === 'preparing' && activity?.stage === 'refineSubtitle')
      return t('activity.preparingRefine');
    if (
      translating &&
      ['preparing', 'requesting', 'validating', 'saving'].includes(phase)
    )
      return t(`activity.translation.${phase}`);
    return t(`activity.phase.${phase}`);
  };
  const phaseText = active
    ? state === 'cancelling' || activity!.status === 'cancelling'
      ? t('activity.cancelling')
      : phaseLabel(activity!.phase)
    : statusText || t(`activity.status.${activity?.status ?? 'idle'}`);
  const summary = activity?.status === 'done' ? activity.summary : undefined;
  const summaryText = summary?.saveFailed
    ? t('activity.saveFailed')
    : [
        summary?.segmentation?.fallback
          ? t('activity.segmentationSummary', summary.segmentation)
          : '',
        summary?.correctionFailed
          ? t('activity.correctionSummary', { count: summary.correctionFailed })
          : '',
      ]
        .filter(Boolean)
        .join(' · ');
  const units = active ? (activity!.units ?? []) : [];
  const seconds = (since: number) =>
    Math.max(0, Math.floor((now - since) / 1000));
  const requests = units.filter((unit) => unit.requestStartedAt != null);
  const oldestRequest = requests.length
    ? Math.min(...requests.map((unit) => unit.requestStartedAt!))
    : null;
  const waitingOnly =
    active &&
    (activity!.phase === 'queued' ||
      activity!.phase === 'interval' ||
      activity!.phase === 'retrying' ||
      (units.length > 0 &&
        units.every((unit) =>
          ['queued', 'interval', 'retrying'].includes(unit.phase),
        )));
  const unitText = (unit: ActivityUnit) => {
    const parts: string[] = [];
    if (unit.retry)
      parts.push(
        t(
          unit.reason === 'validation'
            ? 'activity.validationRetry'
            : 'activity.requestRetry',
          {
            retry: unit.retry,
            max: unit.maxRetries,
          },
        ),
      );
    if (unit.waitUntil != null)
      parts.push(
        t('activity.waitUntil', {
          seconds: Math.max(0, Math.ceil((unit.waitUntil - now) / 1000)),
        }),
      );
    return (
      parts.join(' · ') ||
      (unit.phase === 'requesting' && activity?.stage === 'refineSubtitle'
        ? t('activity.waitingAi')
        : phaseLabel(unit.phase))
    );
  };
  const attentionUnit =
    units.find((unit) => unit.retry) ??
    (waitingOnly ? units.find((unit) => unit.waitUntil != null) : undefined);
  const details: string[] = [];
  let elapsed = '';
  if (active) {
    if (
      activity!.total != null &&
      activity!.unit &&
      (translating || activity!.phase !== 'saving')
    ) {
      details.push(
        t(
          translating
            ? 'activity.translation.received'
            : `activity.count.${activity!.unit}`,
          {
            completed: activity!.completed ?? 0,
            total: activity!.total,
          },
        ),
      );
    }
    if (translating && activity!.savedBatches != null)
      details.push(
        t('activity.translation.saved', { count: activity!.savedBatches }),
      );
    if (
      activity!.processedSeconds != null &&
      activity!.phase === 'recognizing'
    ) {
      details.push(
        t('activity.audioPosition', {
          position: clockTime(activity!.processedSeconds),
          total:
            activity!.durationSeconds != null
              ? ` / ${clockTime(activity!.durationSeconds)}`
              : '',
        }),
      );
    } else if (
      activity!.stage === 'extractSubtitle' &&
      activity!.phase === 'recognizing' &&
      activity!.total == null &&
      Number.isFinite(progress)
    ) {
      details.push(`${Math.round(progress!)}%`);
    }
    if (units.length > 0 && activity!.stage !== 'extractSubtitle')
      details.push(t('activity.activeBatches', { count: units.length }));
    if (attentionUnit) details.push(unitText(attentionUnit));
    elapsed =
      oldestRequest != null
        ? t('activity.requestElapsed', { seconds: seconds(oldestRequest) })
        : units.length === 1 && units[0].phase === 'recognizing'
          ? t('activity.segmentElapsed', {
              seconds: seconds(units[0].startedAt),
            })
          : t('activity.elapsed', {
              seconds: seconds(activity!.phaseStartedAt),
            });
    if (!waitingOnly && seconds(oldestRequest ?? activity!.updatedAt) >= 60) {
      elapsed += ` · ${t(oldestRequest != null || activity!.phase === 'requesting' ? 'activity.noResponse' : 'activity.noUpdate')}`;
    }
  }
  const message = [
    phaseText,
    ...details,
    elapsed,
    !active && summaryText,
    warning,
  ]
    .filter(Boolean)
    .join(' · ');
  // Seconds and numeric progress must not restart motion or spam the live region.
  const transitionKey = `${state}:${active ? `${activity!.run}:${activity!.stage}:${activity!.phase}` : phaseText}`;
  const tone =
    state === 'error'
      ? 'text-destructive'
      : warning || summaryText || state === 'gate' || state === 'cancelling'
        ? 'text-warning'
        : 'text-muted-foreground';

  return (
    <Popover>
      <div
        className={`mt-1.5 flex h-6 min-w-0 items-center overflow-hidden text-xs ${tone}`}
        data-testid="task-activity"
      >
        <span className="sr-only" role="status" aria-live="polite">
          {phaseText}
        </span>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('activity.details')}
            title={message}
            className="flex h-6 w-full min-w-0 items-center gap-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span
              key={transitionKey}
              className="min-w-0 flex-1 truncate motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in motion-safe:duration-200"
              data-testid="task-activity-message"
            >
              {message}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        align="start"
        className="max-h-80 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto break-words text-xs"
      >
        <p className="font-medium">{phaseText}</p>
        {details.length > 0 && <p className="mt-1">{details.join(' · ')}</p>}
        {elapsed && <p className="mt-1 tabular-nums">{elapsed}</p>}
        {active && activity!.coremlFirstRun && (
          <p className="mt-1">{t('activity.coremlFirstRun')}</p>
        )}
        {active &&
          activity!.sourceSaved &&
          activity!.stage === 'refineSubtitle' && (
            <p className="mt-1">{t('activity.sourceSaved')}</p>
          )}
        {units.length > 0 && (
          <ul className="mt-2 space-y-1">
            {[...units]
              .sort((a, b) => a.id - b.id)
              .map((unit) => (
                <li key={unit.id}>
                  {t(
                    activity!.stage === 'extractSubtitle'
                      ? 'activity.segment'
                      : 'activity.batch',
                    { index: unit.id },
                  )}
                  {' · '}
                  {unitText(unit)}
                  {' · '}
                  {t('activity.elapsed', {
                    seconds: seconds(unit.requestStartedAt ?? unit.startedAt),
                  })}
                </li>
              ))}
          </ul>
        )}
        {summaryText && <p className="mt-1 text-warning">{summaryText}</p>}
        {translating && activity?.failedCues ? (
          <p className="mt-1 text-warning">
            {t('row.translationFailureWarning', { count: activity.failedCues })}
          </p>
        ) : null}
        {warning && <p className="mt-1 text-warning">{warning}</p>}
      </PopoverContent>
    </Popover>
  );
});

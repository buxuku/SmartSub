import type { Subtitle } from '../hooks/useSubtitles';
import type { MissedSpeechWarning } from '../../types/missedSpeech';
import type { ResolvedGlossaryEntry } from '../../types/glossary';
import type { QualityIssue } from '../../types/qualityReview';
import { compactQualityCatalog } from '../../types/qualityReview';
import { subtitleHealth } from './subtitleHealth';
import {
  glossarySourceKey,
  normalizedTextContainsGlossarySource,
} from '../../main/glossary/core';

export interface QualityInput {
  subtitles: Subtitle[];
  warnings: MissedSpeechWarning[];
  translation: boolean;
  sourceLanguage?: string;
  targetLanguage?: string;
  duration?: number;
  terms: ResolvedGlossaryEntry[];
}
export const isFailedQualityTranslation = (row: Subtitle) =>
  row.translationStatus === 'failed' ||
  !row.targetContent?.trim() ||
  /^\[翻译失败:/.test(row.targetContent.trim());
const times = (r: Subtitle) => [
  r.startTimeInSeconds ?? 0,
  r.endTimeInSeconds ?? 0,
];
const evidenceRow = (r: Subtitle) => [
  ...times(r),
  r.sourceContent || '',
  r.targetContent || '',
  // SRT persists text and timing, not transient success/pending statuses.
  isFailedQualityTranslation(r),
];

export interface QualityCheckCache {
  scope?: string;
  terms?: ResolvedGlossaryEntry[];
  rows: WeakMap<
    Subtitle,
    {
      index: number;
      previous?: Subtitle;
      next?: Subtitle;
      issues: QualityIssue[];
    }
  >;
}
export const createQualityCheckCache = (): QualityCheckCache => ({
  rows: new WeakMap(),
});

/** Bounded synchronous steps allow the renderer to yield between batches. */
export function* qualityCheckSteps(
  input: QualityInput,
  cache?: QualityCheckCache,
): Generator<QualityIssue[]> {
  const { subtitles: rows, terms } = input;
  const normalizedTerms = terms.map((term) => ({
    term,
    source: glossarySourceKey(term.source),
    target: glossarySourceKey(term.target),
  }));
  const scope = JSON.stringify([
    input.translation,
    input.sourceLanguage,
    input.targetLanguage,
    input.duration,
  ]);
  if (cache && (cache.scope !== scope || cache.terms !== terms)) {
    cache.rows = new WeakMap();
    cache.scope = scope;
    cache.terms = terms;
  }
  const duplicates = new Map<string, number>();
  const anchorCounts = new Map<string, number>();
  for (const row of rows) {
    const anchor = JSON.stringify(times(row));
    anchorCounts.set(anchor, (anchorCounts.get(anchor) || 0) + 1);
  }
  const issue = (
    kind: QualityIssue['kind'],
    indices: number[],
    detail: QualityIssue['detail'],
    extra: {
      start?: number;
      end?: number;
      field?: QualityIssue['field'];
      more?: boolean;
      priority?: number;
      evidence?: unknown;
    } = {},
  ): QualityIssue => {
    const row = rows[indices[0]];
    const start = extra.start ?? row?.startTimeInSeconds ?? 0;
    const end = extra.end ?? row?.endTimeInSeconds ?? start + 0.001;
    const base = JSON.stringify([
      kind,
      start,
      end,
      extra.field || '',
      detail.reason,
      detail.term || '',
    ]);
    const occurrence = duplicates.get(base) || 0;
    duplicates.set(base, occurrence + 1);
    return {
      key: `${base}:${occurrence}`,
      kind,
      indices,
      start,
      end,
      field: extra.field,
      more: extra.more ?? false,
      priority: extra.priority ?? 2,
      evidence: JSON.stringify([
        indices.map((i) => [
          evidenceRow(rows[i]),
          anchorCounts.get(JSON.stringify(times(rows[i]))),
        ]),
        extra.evidence ?? null,
      ]),
      detail,
    };
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cached = cache?.rows.get(r);
    if (
      cached &&
      cached.index === i &&
      cached.previous === rows[i - 1] &&
      cached.next === rows[i + 1] &&
      anchorCounts.get(JSON.stringify(times(r))) === 1
    ) {
      // Update occurrences too: a following duplicate must never reuse this key.
      for (const finding of cached.issues) {
        const base = finding.key.slice(0, finding.key.lastIndexOf(':'));
        duplicates.set(base, (duplicates.get(base) || 0) + 1);
      }
      yield cached.issues;
      continue;
    }
    const result: QualityIssue[] = [];
    if (
      input.translation &&
      r.sourceContent?.trim() &&
      isFailedQualityTranslation(r)
    )
      result.push(
        issue(
          'translation',
          [i],
          { reason: 'translation' },
          { field: 'targetContent', priority: 0 },
        ),
      );
    for (const field of [
      'sourceContent',
      ...(input.translation ? ['targetContent'] : []),
    ] as Array<'sourceContent' | 'targetContent'>) {
      if (field === 'targetContent' && isFailedQualityTranslation(r)) continue;
      const h = subtitleHealth(
        r[field] || '',
        r.startTimeInSeconds,
        r.endTimeInSeconds,
        field === 'sourceContent' ? input.sourceLanguage : input.targetLanguage,
      );
      if (h.tooFast)
        result.push(
          issue(
            'speed',
            [i],
            { reason: 'speed', cps: h.cps!, threshold: h.threshold },
            { field, evidence: h.threshold },
          ),
        );
    }
    if (input.duration && (r.endTimeInSeconds ?? 0) > input.duration + 0.100001)
      result.push(
        issue(
          'timing',
          [i],
          { reason: 'outside' },
          { evidence: input.duration, priority: 1 },
        ),
      );
    if (
      i > 0 &&
      (rows[i - 1].endTimeInSeconds ?? 0) - (r.startTimeInSeconds ?? 0) >
        0.100001
    )
      result.push(
        issue('timing', [i - 1, i], { reason: 'overlap' }, { more: true }),
      );
    if (
      input.translation &&
      r.targetContent?.trim() &&
      !isFailedQualityTranslation(r)
    ) {
      const neighbors = rows
        .slice(Math.max(0, i - 1), i + 2)
        .map((r) => r.targetContent || '');
      const source = glossarySourceKey(r.sourceContent || '');
      const targets = neighbors.map(glossarySourceKey);
      for (const normalized of normalizedTerms) {
        const { term } = normalized;
        if (
          normalizedTextContainsGlossarySource(source, normalized.source) &&
          !targets.some((text) =>
            normalizedTextContainsGlossarySource(text, normalized.target),
          )
        )
          result.push(
            issue(
              'glossary',
              [i],
              {
                reason: 'glossary',
                term: term.source,
                expected: term.target,
                glossary: term.glossaryName,
              },
              {
                field: 'targetContent',
                evidence: [
                  term.source,
                  term.target,
                  term.glossaryId,
                  neighbors,
                ],
              },
            ),
          );
      }
    }
    cache?.rows.set(r, {
      index: i,
      previous: rows[i - 1],
      next: rows[i + 1],
      issues: result,
    });
    yield result;
  }
  for (const warning of input.warnings) {
    const start = warning.startMs / 1000,
      end = warning.endMs / 1000;
    const indices: number[] = [];
    rows.forEach((r, i) => {
      if (
        (r.startTimeInSeconds ?? 0) < end &&
        (r.endTimeInSeconds ?? 0) > start
      )
        indices.push(i);
    });
    yield [
      issue(
        'speech',
        indices,
        {
          reason: warning.signals.includes('timingMismatch')
            ? 'speechTiming'
            : warning.signals.includes('textMismatch')
              ? 'speechText'
              : 'speech',
          suggested: warning.suggestedText,
        },
        {
          start,
          end,
          more: warning.level === 'low',
          priority: 1,
          field: 'sourceContent',
          evidence: [warning.signals, warning.suggestedText],
        },
      ),
    ];
  }
}

export async function checkQuality(
  input: QualityInput,
  signal: AbortSignal,
  cache?: QualityCheckCache,
): Promise<QualityIssue[]> {
  const result: QualityIssue[] = [];
  let start = performance.now();
  const steps = qualityCheckSteps(input, cache);
  for (let step = steps.next(); !step.done; step = steps.next()) {
    const batch = step.value;
    if (signal.aborted) throw new Error('CANCELLED');
    result.push(...batch);
    if (performance.now() - start > 8) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      start = performance.now();
    }
  }
  return result;
}

/** Time/content anchors survive renumbering; ambiguous matches are never auto-applied. */
export function locateQualityIssue(
  issue: QualityIssue,
  rows: Subtitle[],
): number[] {
  if (issue.kind === 'speech')
    return rows.flatMap((r, i) =>
      (r.startTimeInSeconds ?? 0) < issue.end &&
      (r.endTimeInSeconds ?? 0) > issue.start
        ? [i]
        : [],
    );
  const matches = rows.flatMap((r, i) =>
    r.startTimeInSeconds === issue.start && r.endTimeInSeconds === issue.end
      ? [i]
      : [],
  );
  if (matches.length !== 1) return [];
  return issue.detail.reason === 'overlap' && rows[matches[0] + 1]
    ? [matches[0], matches[0] + 1]
    : matches;
}

export function mergeQualityCatalog(
  previous: QualityIssue[],
  issues: QualityIssue[],
  active?: string,
) {
  const live = new Map(issues.map((i) => [i.key, i]));
  // All current findings stay visible. Only retired history is a bounded cache.
  const historical = compactQualityCatalog(
    previous.filter((i) => !live.has(i.key)),
    5000,
    (i) => i.key === active,
  );
  const retained = new Set(historical.map((i) => i.key));
  const result = previous.flatMap((i) => {
    const current = live.get(i.key);
    if (current) {
      live.delete(i.key);
      return [current];
    }
    return retained.has(i.key) ? [i] : [];
  });
  for (const issue of Array.from(live.values())) result.push(issue);
  return previous.length === result.length &&
    previous.every((i, index) => i === result[index])
    ? previous
    : result;
}

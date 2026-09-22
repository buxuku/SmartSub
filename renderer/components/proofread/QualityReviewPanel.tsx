import Link from 'next/link';
import { useRouter } from 'next/router';
import { isProviderConfigured } from '../../lib/providerUtils';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'next-i18next';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Play,
  RotateCcw,
  Sparkles,
  Plus,
  ListChecks,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { QualityControl } from '../../hooks/useQualityReview';
import type {
  QualityIssue,
  QualityReviewState,
} from '../../../types/qualityReview';
import type { Subtitle } from '../../hooks/useSubtitles';
import { locateQualityIssue } from '../../lib/qualityChecks';
import type { InlineAiControl } from '../../hooks/useInlineAi';
import { speechRangeTime } from '../subtitle/MissedSpeechControls';
import { cueSnapshot, cueStructure } from '../../lib/inlineAi';

interface Props {
  control: QualityControl;
  state: QualityReviewState;
  rows: Subtitle[];
  onSelect: (issue: QualityIssue, indices: number[]) => void;
  onVisible: (indices: number[]) => void;
  onListen?: (issue: QualityIssue) => void;
  onLoop: (loop: boolean) => void;
  loop: boolean;
  ai: InlineAiControl;
  projectId?: string;
  documentKey: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  translation: boolean;
  getSubtitles: () => Subtitle[];
  insert: (
    start: number,
    end: number,
    source: string,
    target?: string,
  ) => boolean;
  editor: React.ReactNode;
  onComplete: () => void;
}
export default function QualityReviewPanel(p: Props) {
  const { t } = useTranslation('home');
  const router = useRouter();
  const configuredAi = p.ai.providers.some(
    (provider) =>
      provider.id === p.ai.providerId && isProviderConfigured(provider),
  );
  const q = (key: string, options?: Record<string, unknown>) =>
    t(`quality.${key}`, options);
  const [active, setActive] = useState(p.state.view.active || '');
  useEffect(() => {
    setActive(p.state.view.active || '');
  }, [p.state.view.active]);
  const [context, setContext] = useState(false);
  const insertion = p.state.insertionDrafts?.[active];
  const editInsertion = (patch: Partial<NonNullable<typeof insertion>>) => {
    if (insertion) p.control.editInsertion(active, { ...insertion, ...patch });
  };
  const [actionError, setActionError] = useState('');
  const [translating, setTranslating] = useState(false);
  const request = useRef<string | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSelected = useRef('');
  const selectedSnapshot = useRef<QualityIssue | null>(null);
  const pinnedRows = useRef<{
    key: string;
    rows: Subtitle[];
    indices: number[];
  } | null>(null);

  useEffect(
    () => () => {
      if (request.current)
        void window.ipc.invoke('cancelProofreadBatch', {
          batchId: request.current,
        });
      request.current = null;
    },
    [p.documentKey],
  );

  const eligible = useMemo(
    () =>
      p.control.catalog
        .filter((i) => {
          const status = p.control.status(i);
          return (
            (!i.more || p.state.view.more) &&
            (p.state.view.kind === 'all' || i.kind === p.state.view.kind) &&
            (p.state.view.status === 'processed'
              ? status === 'fixed' || status === 'confirmed'
              : status === p.state.view.status)
          );
        })
        .sort(
          (a, b) =>
            (p.state.view.sort === 'priority' ? a.priority - b.priority : 0) ||
            a.start - b.start ||
            a.key.localeCompare(b.key),
        ),
    [p.control.catalog, p.control.status, p.state.view],
  );
  // Keep the expanded item mounted after its conditions disappear.
  const selected =
    p.control.catalog.find((i) => i.key === active) || selectedSnapshot.current;
  const list = useMemo(
    () =>
      selected && !eligible.some((i) => i.key === selected.key)
        ? [...eligible, selected].sort(
            (a, b) =>
              (p.state.view.sort === 'priority'
                ? a.priority - b.priority
                : 0) ||
              a.start - b.start ||
              a.key.localeCompare(b.key),
          )
        : eligible,
    [eligible, selected, p.state.view.sort],
  );
  // Group same-cue reasons without multiplying list rows.
  const groups = useMemo(() => {
    const map = new Map<string, QualityIssue[]>();
    list.forEach((i) => {
      const key = `${i.start}:${i.end}`;
      const group = map.get(key);
      if (group) group.push(i);
      else map.set(key, [i]);
    });
    return Array.from(map.values());
  }, [list]);
  const virtual = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 4,
  });
  const issue = p.control.current.get(active) || selected;
  const indices = useMemo(() => {
    if (!issue) return [];
    let found = locateQualityIssue(issue, p.rows);
    const pinned = pinnedRows.current;
    // Timing edits can eliminate the original finding. Keep its editors in place
    // while the rest of the document retains the same structure and identity.
    if (
      !found.length &&
      pinned?.key === issue.key &&
      pinned.rows.length === p.rows.length
    ) {
      const selected = new Set(pinned.indices);
      if (p.rows.every((row, i) => selected.has(i) || pinned.rows[i] === row))
        found = pinned.indices;
    }
    if (found.length)
      pinnedRows.current = { key: issue.key, rows: p.rows, indices: found };
    return found;
  }, [issue, p.rows]);
  const related = issue
    ? p.control.catalog.filter(
        (i) =>
          i.start === issue.start &&
          i.end === issue.end &&
          (!i.more || p.state.view.more),
      )
    : [];

  const select = (next: QualityIssue) => {
    selectedSnapshot.current = next;
    setActive(next.key);
    setContext(false);
    setActionError('');
    p.control.view({ active: next.key });
  };
  useEffect(() => {
    if (!active && eligible[0]) select(eligible[0]);
  }, [active, eligible]);
  useEffect(() => {
    if (!issue) {
      p.onVisible([]);
      return;
    }
    const visible = new Set(indices);
    if (context && indices.length) {
      const first = Math.max(0, indices[0] - 2),
        last = Math.min(p.rows.length - 1, indices[indices.length - 1] + 2);
      for (let i = first; i <= last; i++) visible.add(i);
    }
    p.onVisible(Array.from(visible).sort((a, b) => a - b));
    if (lastSelected.current !== issue.key) {
      lastSelected.current = issue.key;
      p.onSelect(issue, indices);
    }
  }, [issue?.key, indices, context, p.rows.length]);

  const move = (delta: number) => {
    const groupIndex = groups.findIndex((group) =>
      group.some((i) => i.key === active),
    );
    const next = groups[groupIndex + delta]?.[0];
    if (next) {
      select(next);
      virtual.scrollToIndex(groupIndex + delta, { align: 'auto' });
    }
  };
  const reason = (i: QualityIssue) =>
    q(`reason.${i.detail.reason}`, {
      cps: i.detail.cps?.toFixed(1),
      threshold: i.detail.threshold,
      term: i.detail.term,
      expected: i.detail.expected,
      glossary: i.detail.glossary,
    });
  const retranslate = async () => {
    if (request.current || indices.length !== 1) return;
    const index = indices[0],
      rows = p.getSubtitles(),
      row = rows[index];
    const snapshot = cueSnapshot(row),
      structure = cueStructure(rows),
      documentKey = p.documentKey;
    const id = crypto.randomUUID();
    request.current = id;
    setTranslating(true);
    setActionError('');
    try {
      const result = await window.ipc.invoke('retranslateSubtitles', {
        projectId: p.projectId,
        providerId: configuredAi ? p.ai.providerId : undefined,
        batchId: id,
        sourceLanguage: p.sourceLanguage,
        targetLanguage: p.targetLanguage,
        subtitles: [
          {
            id: row.id,
            startEndTime: row.startEndTime,
            content: (row.sourceContent || '').split('\n'),
          },
        ],
      });
      if (request.current !== id || latest.current.documentKey !== documentKey)
        return;
      const current = p.getSubtitles();
      if (
        cueStructure(current) !== structure ||
        !current[index] ||
        cueSnapshot(current[index]) !== snapshot
      )
        throw new Error(q('stale'));
      const text = result?.data?.find(
        (r) => r.id === row.id && r.startEndTime === row.startEndTime,
      )?.targetContent;
      if (!result?.success || !text?.trim())
        throw new Error(
          result?.error === 'NO_DEFAULT_PROVIDER'
            ? q('noTranslation')
            : result?.error || q('noResult'),
        );
      p.ai.propose(index, text, 'targetContent');
    } catch (error) {
      if (request.current === id) setActionError(String(error));
    } finally {
      if (request.current === id) {
        request.current = null;
        setTranslating(false);
      }
    }
  };
  const groupIndex = groups.findIndex((group) =>
    group.some((i) => i.key === active),
  );
  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-auto rounded-md bg-card"
      aria-label={q('title')}
      data-quality-panel
    >
      <div className="shrink-0 space-y-2 border-b p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={q('statusFilter')}
            className="h-8 rounded border bg-background px-2"
            value={p.state.view.status}
            onChange={(e) => {
              setActive('');
              selectedSnapshot.current = null;
              p.control.view({
                status: e.target.value as any,
                active: undefined,
              });
            }}
          >
            {['pending', 'skipped', 'processed'].map((v) => (
              <option key={v} value={v}>
                {q(`filter.${v}`)}
              </option>
            ))}
          </select>
          <select
            aria-label={q('typeFilter')}
            className="h-8 rounded border bg-background px-2"
            value={p.state.view.kind}
            onChange={(e) => {
              setActive('');
              selectedSnapshot.current = null;
              p.control.view({
                kind: e.target.value as any,
                active: undefined,
              });
            }}
          >
            {[
              'all',
              'translation',
              'speech',
              'speed',
              'timing',
              'glossary',
            ].map((v) => (
              <option key={v} value={v}>
                {q(`kind.${v}`)}
              </option>
            ))}
          </select>
          <select
            aria-label={q('sort')}
            className="h-8 rounded border bg-background px-2"
            value={p.state.view.sort}
            onChange={(e) => p.control.view({ sort: e.target.value as any })}
          >
            <option value="time">{q('timeOrder')}</option>
            <option value="priority">{q('priorityOrder')}</option>
          </select>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={p.state.view.more}
              onChange={(e) => p.control.view({ more: e.target.checked })}
            />
            {q('more')}
          </label>
        </div>
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground"
          role="status"
        >
          {(['pending', 'fixed', 'confirmed', 'skipped'] as const).map((v) => (
            <span key={v}>
              {q(`status.${v}`)} {p.control.counts[v]}
            </span>
          ))}
          {p.control.checking && (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {q('checking')}
            </span>
          )}
        </div>
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">{q('coverage')}</summary>
          <p className="mt-1">{q('localOnly')}</p>
          {!p.onListen && <p>{q('noMedia')}</p>}
          {!p.control.terms.length && !p.control.glossaryError && (
            <p>{q('noGlossary')}</p>
          )}
          {!p.control.catalog.some((i) => i.kind === 'speech') && (
            <p>{q('speechCoverage')}</p>
          )}
        </details>
        {(p.control.error || p.control.glossaryError) && (
          <div role="alert" className="text-destructive">
            {q('partialFailure')}
            <details>
              <summary>{q('details')}</summary>
              {p.control.error || p.control.glossaryError}
            </details>
            <Button size="sm" variant="outline" onClick={p.control.retry}>
              {q('retry')}
            </Button>
          </div>
        )}
      </div>
      <div
        ref={scrollRef}
        className="h-[72px] min-h-[48px] shrink-0 overflow-auto border-b"
        tabIndex={0}
        aria-label={q('issueList')}
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).closest('input,textarea,select'))
            return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            move(e.key === 'ArrowDown' ? 1 : -1);
          }
        }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((item) => {
            const group = groups[item.index],
              first = group.find((i) => i.key === active) || group[0];
            return (
              <button
                key={first.start + ':' + first.end}
                className={`absolute left-0 flex w-full items-center gap-3 px-3 text-left text-xs hover:bg-accent ${group.some((i) => i.key === active) ? 'bg-primary/10 text-primary' : ''}`}
                style={{ top: item.start, height: item.size }}
                onClick={(e) => {
                  select(first);
                  e.currentTarget.parentElement?.parentElement?.focus();
                }}
                aria-current={
                  group.some((i) => i.key === active) ? 'true' : undefined
                }
              >
                <span className="font-mono tabular-nums">
                  {speechRangeTime(first.start * 1000)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {Array.from(
                    new Set(group.map((i) => q(`kind.${i.kind}`))),
                  ).join(' · ')}
                </span>
                <span>
                  {q(
                    `status.${group.some((i) => p.control.status(i) === 'pending') ? 'pending' : group.some((i) => p.control.status(i) === 'skipped') ? 'skipped' : p.control.status(first)}`,
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {!issue ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <ListChecks className="h-7 w-7" />
          <p>
            {p.control.checking
              ? q('checking')
              : p.control.catalog.length
                ? q('emptyFilter')
                : q('empty')}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => p.control.view({ mode: 'all' })}
          >
            {q('all')}
          </Button>
          <Button size="sm" onClick={p.onComplete}>
            {q('complete')}
          </Button>
        </div>
      ) : (
        <>
          <div
            className="max-h-[26vh] shrink-0 space-y-2 overflow-auto bg-panel-2 p-3 text-xs"
            data-quality-detail
          >
            {related.map((i) => (
              <div key={i.key} className="flex flex-wrap items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <div className="min-w-[180px] flex-1">
                  <p>
                    {i.field && (
                      <button
                        className="mr-1 font-medium text-primary underline-offset-2 hover:underline"
                        onClick={() => select(i)}
                      >
                        {q(
                          i.field === 'sourceContent'
                            ? 'originalField'
                            : 'translationField',
                        )}
                      </button>
                    )}
                    {reason(i)}
                  </p>
                  <span className="text-muted-foreground">
                    {q(`status.${p.control.status(i)}`)}
                  </span>
                </div>
                <div className="flex shrink-0 gap-1">
                  {p.control.status(i) === 'pending' ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={p.control.checking}
                        onClick={() => p.control.decide(i, 'confirmed')}
                      >
                        {q('confirm')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={p.control.checking}
                        onClick={() => p.control.decide(i, 'skipped')}
                      >
                        {q('skip')}
                      </Button>
                      {i.kind === 'speech' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={p.control.checking}
                          onClick={() => p.control.decide(i, 'fixed')}
                        >
                          {q('markFixed')}
                        </Button>
                      )}
                    </>
                  ) : p.control.status(i) !== 'fixed' || i.kind === 'speech' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={p.control.checking}
                      onClick={() => p.control.decide(i)}
                    >
                      {q('reopen')}
                    </Button>
                  ) : (
                    <Check className="h-4 w-4 text-success" />
                  )}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-1">
              {p.onListen && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => p.onListen?.(issue)}
                  >
                    <Play className="mr-1 h-3.5 w-3.5" />
                    {q('listen')}
                  </Button>
                  <label className="mx-1 flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={p.loop}
                      onChange={(e) => p.onLoop(e.target.checked)}
                    />
                    {q('loop')}
                  </label>
                </>
              )}
              {!!indices.length && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setContext((v) => !v)}
                >
                  {q(context ? 'hideContext' : 'context')}
                </Button>
              )}
              {indices.length === 1 && (
                <>
                  {issue.kind === 'translation' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={translating}
                      onClick={() => void retranslate()}
                    >
                      {translating ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                      )}
                      {q('retranslate')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={p.ai.running || !configuredAi}
                    onClick={() =>
                      void p.ai.run(
                        [indices[0]],
                        issue.kind === 'speed' ? 'shorten' : 'polish',
                        issue.field || 'sourceContent',
                      )
                    }
                  >
                    <Sparkles className="mr-1 h-3.5 w-3.5" />
                    {q(
                      issue.field === 'targetContent' ? 'aiTarget' : 'aiSource',
                    )}
                  </Button>
                  {issue.detail.suggested && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        p.ai.propose(
                          indices[0],
                          issue.detail.suggested!,
                          'sourceContent',
                        )
                      }
                    >
                      {q('suggestion')}
                    </Button>
                  )}
                </>
              )}
              {issue.kind === 'glossary' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(issue.detail.expected || '')
                      .catch((e) => setActionError(String(e)))
                  }
                >
                  {q('copyTerm')}
                </Button>
              )}
              {issue.kind === 'speech' && !indices.length && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!insertion)
                      p.control.editInsertion(active, {
                        start: String(issue.start),
                        end: String(issue.end),
                        source: issue.detail.suggested || '',
                        target: '',
                      });
                  }}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {q('insert')}
                </Button>
              )}
            </div>
            {!configuredAi && (
              <p className="text-muted-foreground">
                {q('noAi')}{' '}
                <Link
                  className="text-primary underline"
                  href={`/${router.query.locale || 'zh'}/translation`}
                >
                  {q('configure')}
                </Link>
              </p>
            )}
            {translating && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const id = request.current;
                  request.current = null;
                  setTranslating(false);
                  if (id)
                    void window.ipc.invoke('cancelProofreadBatch', {
                      batchId: id,
                    });
                }}
              >
                {q('cancel')}
              </Button>
            )}
            {actionError && (
              <div role="alert" className="text-destructive">
                {actionError}
              </div>
            )}
            {insertion && (
              <div className="space-y-2" data-quality-insert>
                <div className="flex gap-2">
                  <label className="flex-1">
                    {q('start')}
                    <Input
                      type="number"
                      step="0.001"
                      value={insertion.start}
                      onChange={(e) => editInsertion({ start: e.target.value })}
                    />
                  </label>
                  <label className="flex-1">
                    {q('end')}
                    <Input
                      type="number"
                      step="0.001"
                      value={insertion.end}
                      onChange={(e) => editInsertion({ end: e.target.value })}
                    />
                  </label>
                </div>
                <Textarea
                  aria-label={q('source')}
                  value={insertion.source}
                  onChange={(e) => editInsertion({ source: e.target.value })}
                />
                {p.translation && (
                  <Textarea
                    aria-label={q('target')}
                    value={insertion.target}
                    onChange={(e) => editInsertion({ target: e.target.value })}
                  />
                )}
                <Button
                  size="sm"
                  onClick={() => {
                    if (
                      !insertion.start.trim() ||
                      !insertion.end.trim() ||
                      !p.insert(
                        Number(insertion.start),
                        Number(insertion.end),
                        insertion.source,
                        insertion.target,
                      )
                    )
                      setActionError(q('invalidInsert'));
                    else {
                      p.control.editInsertion(active);
                      setActionError('');
                    }
                  }}
                >
                  {q('add')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => p.control.editInsertion(active)}
                >
                  {q('cancel')}
                </Button>
              </div>
            )}
          </div>
          <div className="min-h-[180px] flex-1">
            {indices.length ? (
              p.editor
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                {q(issue.kind === 'speech' ? 'gap' : 'changedRange')}
              </div>
            )}
          </div>
          <div className="sticky bottom-0 z-10 flex shrink-0 items-center justify-between gap-2 border-t bg-card p-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={groupIndex <= 0}
              onClick={() => move(-1)}
            >
              <ChevronUp className="mr-1 h-4 w-4" />
              {q('previous')}
            </Button>
            <span className="text-xs text-muted-foreground">
              {Math.max(0, groupIndex + 1)} / {groups.length}
            </span>
            {groupIndex < groups.length - 1 ? (
              <Button size="sm" onClick={() => move(1)}>
                {q('next')}
                <ChevronDown className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  selectedSnapshot.current = null;
                  setActive('');
                  p.control.view({
                    status: p.control.counts.skipped ? 'skipped' : 'processed',
                    active: undefined,
                  });
                }}
              >
                {q(p.control.counts.skipped ? 'reviewSkipped' : 'reviewDone')}
              </Button>
            )}
            {p.state.view.status === 'processed' && (
              <Button size="sm" onClick={p.onComplete}>
                {q('complete')}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

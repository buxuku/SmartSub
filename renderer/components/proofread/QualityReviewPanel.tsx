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
  HelpCircle,
  List,
  ArrowLeft,
  SlidersHorizontal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import styles from './QualityReviewPanel.module.css';
import SpeechGapContext from './SpeechGapContext';
import TimecodeInput from './TimecodeInput';
import { formatTimecode, parseTimecode } from '../../lib/timecode';
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
    issue?: QualityIssue,
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
  const [contextOverride, setContext] = useState<boolean | undefined>();
  const [listOpen, setListOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const gapContextRef = useRef<HTMLDivElement>(null);
  const insertion = p.state.insertionDrafts?.[active];
  const editInsertion = (patch: Partial<NonNullable<typeof insertion>>) => {
    setActionError('');
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
    estimateSize: () => 88,
    overscan: 4,
  });
  const issue = p.control.current.get(active) || selected;
  const context = contextOverride ?? issue?.kind === 'speech';
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
    setContext(undefined);
    setActionError('');
    p.control.view({ active: next.key });
  };
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [active]);
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
  useEffect(() => {
    if (groupIndex < 0) return;
    const frame = requestAnimationFrame(() =>
      virtual.scrollToIndex(groupIndex, { align: 'auto' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [groupIndex, listOpen, virtual]);
  const processedCount = p.control.counts.fixed + p.control.counts.confirmed;
  const totalCount =
    processedCount + p.control.counts.pending + p.control.counts.skipped;
  return (
    <section
      className={`${styles.panel} flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card`}
      aria-label={q('title')}
      data-quality-panel
    >
      <header className="shrink-0 border-b px-4 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{q('workspaceTitle')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {q('workflow')}
            </p>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="shrink-0">
                <HelpCircle className="h-4 w-4" />
                {q('help')}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="max-h-[70vh] w-80 overflow-y-auto text-xs leading-relaxed"
            >
              <h3 className="mb-2 font-semibold">{q('help')}</h3>
              <ol className="list-decimal space-y-2 pl-4">
                <li>{q('helpListen')}</li>
                <li>{q('helpEdit')}</li>
                <li>{q('helpDecide')}</li>
              </ol>
              <h3 className="mb-1 mt-4 font-semibold">{q('coverage')}</h3>
              <div className="space-y-2 text-muted-foreground">
                <p>{q('localOnly')}</p>
                {!p.onListen && <p>{q('noMedia')}</p>}
                {!p.control.terms.length && !p.control.glossaryError && (
                  <p>{q('noGlossary')}</p>
                )}
                {!p.control.catalog.some((i) => i.kind === 'speech') && (
                  <p>{q('speechCoverage')}</p>
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
            </PopoverContent>
          </Popover>
        </div>
        <div
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
          role="status"
        >
          {(['pending', 'fixed', 'confirmed', 'skipped'] as const).map((v) => (
            <span
              key={v}
              className={v === 'pending' ? 'font-medium text-foreground' : ''}
            >
              {q(`status.${v}`)}{' '}
              <span className="tabular-nums">{p.control.counts[v]}</span>
            </span>
          ))}
          {p.control.checking && (
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {q('checking')}
            </span>
          )}
        </div>
        <div
          role="progressbar"
          aria-label={q('progress')}
          aria-valuemin={0}
          aria-valuemax={Math.max(1, totalCount)}
          aria-valuenow={processedCount}
          className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-success transition-[width]"
            style={{
              width: `${totalCount ? (processedCount / totalCount) * 100 : 0}%`,
            }}
          />
        </div>
        {(p.control.error || p.control.glossaryError) && (
          <div role="alert" className="mt-2 text-xs text-destructive">
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
      </header>
      <div className={styles.workspace} data-list-open={listOpen}>
        <aside
          className={`${styles.navigation} bg-panel-2`}
          aria-label={q('issueNavigation')}
        >
          <div className="shrink-0 space-y-3 border-b p-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">
                {q('issueList')}{' '}
                <span className="ml-1 font-normal text-muted-foreground">
                  {groups.length}
                </span>
              </h3>
              <Button
                size="sm"
                variant="ghost"
                className={styles.listToggle}
                onClick={() => setListOpen(false)}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {q('backToIssue')}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                aria-label={q('statusFilter')}
                className="h-8 min-w-0 rounded-md border bg-card px-2 text-xs"
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
                className="h-8 min-w-0 rounded-md border bg-card px-2 text-xs"
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
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full justify-between"
                >
                  <span className="flex items-center gap-1.5">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    {q('filterOptions')}
                  </span>
                  <span className="font-normal">
                    {q(
                      p.state.view.sort === 'time'
                        ? 'timeOrder'
                        : 'priorityOrder',
                    )}
                    {p.state.view.more ? ' · ' + q('more') : ''}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="space-y-3 text-xs">
                <label className="flex items-center justify-between gap-2">
                  {q('sort')}
                  <select
                    aria-label={q('sort')}
                    className="h-8 min-w-0 rounded-md border bg-card px-2 text-xs"
                    value={p.state.view.sort}
                    onChange={(e) =>
                      p.control.view({ sort: e.target.value as any })
                    }
                  >
                    <option value="time">{q('timeOrder')}</option>
                    <option value="priority">{q('priorityOrder')}</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={p.state.view.more}
                    onChange={(e) => p.control.view({ more: e.target.checked })}
                  />
                  {q('more')}
                </label>
                <p className="text-muted-foreground">{q('moreHelp')}</p>
              </PopoverContent>
            </Popover>
          </div>
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
            id="quality-issue-list"
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
            {!groups.length && (
              <div className="space-y-3 p-4 text-center text-xs text-muted-foreground">
                <p>{q(p.control.checking ? 'checking' : 'emptyFilter')}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    p.control.view({ status: 'pending', kind: 'all' })
                  }
                >
                  {q('resetFilters')}
                </Button>
              </div>
            )}
            <div
              style={{ height: virtual.getTotalSize(), position: 'relative' }}
            >
              {virtual.getVirtualItems().map((item) => {
                const group = groups[item.index],
                  first = group.find((i) => i.key === active) || group[0];
                return (
                  <button
                    key={first.start + ':' + first.end}
                    className={`absolute left-0 flex w-full flex-col justify-center gap-1 border-b border-l-2 px-3 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${group.some((i) => i.key === active) ? 'border-l-primary bg-primary/10' : 'border-l-transparent'}`}
                    style={{ top: item.start, height: item.size }}
                    onClick={() => {
                      select(first);
                      setListOpen(false);
                      requestAnimationFrame(() => {
                        const target = scrollRef.current?.offsetParent
                          ? scrollRef.current
                          : contentRef.current;
                        target?.focus({ preventScroll: true });
                      });
                    }}
                    aria-current={
                      group.some((i) => i.key === active) ? 'true' : undefined
                    }
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="font-mono tabular-nums text-muted-foreground">
                        {speechRangeTime(first.start * 1000)}
                      </span>
                      <span
                        className={`text-[11px] ${group.some((i) => p.control.status(i) === 'pending') ? 'text-warning' : 'text-muted-foreground'}`}
                      >
                        {q(
                          `status.${group.some((i) => p.control.status(i) === 'pending') ? 'pending' : group.some((i) => p.control.status(i) === 'skipped') ? 'skipped' : p.control.status(first)}`,
                        )}
                      </span>
                    </span>
                    <span className="w-full truncate font-medium">
                      {Array.from(
                        new Set(group.map((i) => q(`kind.${i.kind}`))),
                      ).join(' · ')}
                    </span>
                    <span className="w-full truncate text-muted-foreground">
                      {p.rows[first.indices[0]]?.sourceContent ||
                        q(
                          first.kind === 'speech'
                            ? 'missingSubtitle'
                            : 'viewIssue',
                        )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
        <div className={styles.detail}>
          <div
            className={`${styles.listToggle} flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2`}
          >
            <Button
              variant="outline"
              size="sm"
              aria-expanded={listOpen}
              aria-controls="quality-issue-list"
              onClick={() => setListOpen(true)}
            >
              <List className="h-4 w-4" />
              {q('issueList')}
              <span className="tabular-nums">{groups.length}</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            <span className="truncate text-xs text-muted-foreground">
              {q(`filter.${p.state.view.status}`)} ·{' '}
              {q(`kind.${p.state.view.kind}`)}
            </span>
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
                ref={contentRef}
                tabIndex={-1}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus:outline-none"
                data-quality-content
              >
                <div className="space-y-3 p-4 text-xs" data-quality-detail>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">
                      {q(`kind.${issue.kind}`)}
                    </h3>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {speechRangeTime(issue.start * 1000)} –{' '}
                      {speechRangeTime(issue.end * 1000)}
                    </span>
                  </div>
                  {related.map((i) => (
                    <div
                      key={i.key}
                      className="flex flex-wrap items-start gap-2 rounded-md border border-warning/20 bg-warning/5 p-3"
                    >
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                      <div className="min-w-0 basis-full flex-1 sm:basis-[200px]">
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
                      <div className="flex w-full flex-wrap items-center gap-1 pl-5">
                        {p.control.status(i) === 'pending' ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={p.control.checking}
                              title={q('confirmHelp')}
                              onClick={() => p.control.decide(i, 'confirmed')}
                            >
                              {q('confirm')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={p.control.checking}
                              title={q('skipHelp')}
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
                        ) : p.control.status(i) !== 'fixed' ||
                          i.kind === 'speech' ? (
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
                  <p className="leading-relaxed text-muted-foreground">
                    {q(
                      !indices.length && issue.kind === 'speech'
                        ? 'gap'
                        : `guidance.${issue.kind}`,
                    )}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
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
                        onClick={() => setContext(!context)}
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
                            issue.field === 'targetContent'
                              ? 'aiTarget'
                              : 'aiSource',
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
                    {issue.kind === 'speech' &&
                      !indices.length &&
                      !insertion && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (!insertion)
                              p.control.editInsertion(active, {
                                start: formatTimecode(issue.start),
                                end: formatTimecode(issue.end),
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
                  {actionError && !insertion && (
                    <div role="alert" className="text-destructive">
                      {actionError}
                    </div>
                  )}
                  {issue.kind === 'speech' && !indices.length && (
                    <div ref={gapContextRef}>
                      <SpeechGapContext
                        key={issue.key}
                        issue={issue}
                        rows={p.rows}
                        translation={p.translation}
                        onListen={p.onListen}
                      />
                    </div>
                  )}
                  {insertion && (
                    <div
                      className="space-y-4 rounded-lg border bg-panel-2 p-4"
                      data-quality-insert
                    >
                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="text-sm font-semibold">
                            {q('insert')}
                          </h4>
                          {issue.kind === 'speech' && !indices.length && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                gapContextRef.current?.scrollIntoView({
                                  block: 'start',
                                })
                              }
                            >
                              <ChevronUp className="h-3.5 w-3.5" />
                              {q('gapContext.compare')}
                            </Button>
                          )}
                        </div>
                        <p className="mt-1 leading-relaxed text-muted-foreground">
                          {q('insertHelp')}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <label className="min-w-0 flex-1 space-y-1">
                          {q('start')}
                          <TimecodeInput
                            key={`${active}-start`}
                            aria-describedby="quality-timecode-hint"
                            aria-invalid={
                              !!actionError &&
                              parseTimecode(insertion.start) === null
                            }
                            value={insertion.start}
                            onChange={(value) =>
                              editInsertion({ start: value })
                            }
                          />
                        </label>
                        <label className="min-w-0 flex-1 space-y-1">
                          {q('end')}
                          <TimecodeInput
                            key={`${active}-end`}
                            aria-describedby="quality-timecode-hint"
                            aria-invalid={
                              !!actionError &&
                              parseTimecode(insertion.end) === null
                            }
                            value={insertion.end}
                            onChange={(value) => editInsertion({ end: value })}
                          />
                        </label>
                      </div>
                      <p
                        id="quality-timecode-hint"
                        className="text-muted-foreground"
                      >
                        {q('timecodeHint')}
                      </p>
                      <label className="block space-y-1.5">
                        <span className="font-medium">{q('source')}</span>
                        <Textarea
                          autoFocus
                          rows={4}
                          className="min-h-[104px] bg-card text-sm"
                          placeholder={q('sourcePlaceholder')}
                          value={insertion.source}
                          onChange={(e) =>
                            editInsertion({ source: e.target.value })
                          }
                        />
                      </label>
                      {p.translation && (
                        <label className="block space-y-1.5">
                          <span>{q('target')}</span>
                          <Textarea
                            rows={3}
                            className="bg-card text-sm"
                            placeholder={q('targetPlaceholder')}
                            value={insertion.target}
                            onChange={(e) =>
                              editInsertion({ target: e.target.value })
                            }
                          />
                        </label>
                      )}
                      {actionError && (
                        <p role="alert" className="text-destructive">
                          {actionError}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => {
                            const start = parseTimecode(insertion.start);
                            const end = parseTimecode(insertion.end);
                            if (start === null || end === null) {
                              setActionError(q('invalidTimecode'));
                              return;
                            }
                            if (
                              !p.insert(
                                start,
                                end,
                                insertion.source,
                                insertion.target,
                                issue,
                              )
                            )
                              setActionError(q('invalidInsert'));
                            else {
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
                    </div>
                  )}
                </div>
                {indices.length ? (
                  <div className="border-t px-3 pb-4 pt-3">
                    <h4 className="mb-2 px-1 text-xs font-medium text-muted-foreground">
                      {q(context ? 'contextTitle' : 'editTitle')}
                    </h4>
                    {p.editor}
                  </div>
                ) : issue.kind !== 'speech' ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    {q('changedRange')}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-card px-3 py-2.5">
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
                        status: p.control.counts.skipped
                          ? 'skipped'
                          : 'processed',
                        active: undefined,
                      });
                    }}
                  >
                    {q(
                      p.control.counts.skipped ? 'reviewSkipped' : 'reviewDone',
                    )}
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
        </div>
      </div>
    </section>
  );
}

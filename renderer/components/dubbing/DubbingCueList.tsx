/**
 * 字幕行列表（虚拟滚动）：行状态 / 行级 voice / 试听 / 重生成 / 过长兜底。
 * 点击行展开编辑区（改文案重合成、接受变速）。
 */
import React, { useMemo, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Play,
  Square,
  RotateCcw,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  CircleAlert,
  Layers,
  Filter,
  ListMusic,
} from 'lucide-react';
import { cn } from 'lib/utils';
import type { UseDubbingReturn } from '../../hooks/useDubbing';
import type { DubbingCueView } from '../../../types/dubbing';

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

type CueFilter = 'all' | 'overlong' | 'failed';

export default function DubbingCueList({
  dub,
  currentTimeMs,
  onSeek,
}: {
  dub: UseDubbingReturn;
  /** 播放器当前进度（ms，无视频时 -1）。 */
  currentTimeMs: number;
  onSeek?: (ms: number) => void;
}) {
  const { t } = useTranslation('dubbing');
  const {
    cues,
    activeEngine,
    running,
    resynthesizeCue,
    acceptOverlong,
    setCueVoice,
    playCue,
    playingKey,
    playAll,
    playingAll,
    summary,
  } = dub;

  const [filter, setFilter] = useState<CueFilter>('all');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [draftText, setDraftText] = useState('');

  const visible = useMemo(() => {
    if (filter === 'overlong') {
      return cues.filter(
        (c) => c.status === 'overlong' || c.status === 'accepted',
      );
    }
    if (filter === 'failed') return cues.filter((c) => c.status === 'failed');
    return cues;
  }, [cues, filter]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });

  // 播放进度 → 当前行高亮（仅有视频进度时）。
  const activePlaybackIndex = useMemo(() => {
    if (currentTimeMs < 0) return -1;
    const hit = cues.find(
      (c) => currentTimeMs >= c.startMs && currentTimeMs < c.endMs,
    );
    return hit?.index ?? -1;
  }, [cues, currentTimeMs]);

  const toggleExpand = useCallback(
    (cue: DubbingCueView) => {
      if (expandedIndex === cue.index) {
        setExpandedIndex(null);
      } else {
        setExpandedIndex(cue.index);
        setDraftText(cue.text);
      }
    },
    [expandedIndex],
  );

  const statusBadge = (cue: DubbingCueView) => {
    switch (cue.status) {
      case 'synthesizing':
        return (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-primary"
            aria-label={t('statusSynthesizing')}
          />
        );
      case 'done':
        return (
          <CheckCircle2
            className="h-3.5 w-3.5 text-success"
            aria-label={t('statusDone')}
          />
        );
      case 'accepted':
        return (
          <CheckCircle2
            className="h-3.5 w-3.5 text-warning"
            aria-label={t('statusAccepted')}
          />
        );
      case 'overlong':
        return (
          <AlertTriangle
            className="h-3.5 w-3.5 text-warning"
            aria-label={t('statusOverlong')}
          />
        );
      case 'failed':
        return (
          <CircleAlert
            className="h-3.5 w-3.5 text-destructive"
            aria-label={t('statusFailed')}
          />
        );
      default:
        return (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
            aria-label={t('statusPending')}
          />
        );
    }
  };

  if (cues.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('emptyCueList')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 过滤条 */}
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b px-2 py-1.5 text-xs">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />
        <Button
          variant={filter === 'all' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setFilter('all')}
        >
          {t('filterAll', { count: cues.length })}
        </Button>
        <Button
          variant={filter === 'overlong' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-xs text-warning"
          onClick={() => setFilter('overlong')}
          disabled={summary.overlong === 0 && filter !== 'overlong'}
        >
          {t('filterOverlong', { count: summary.overlong })}
        </Button>
        <Button
          variant={filter === 'failed' ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-xs text-destructive"
          onClick={() => setFilter('failed')}
          disabled={summary.failed === 0 && filter !== 'failed'}
        >
          {t('filterFailed', { count: summary.failed })}
        </Button>
        {summary.overlap > 0 && (
          <span className="ml-2 flex items-center gap-1 text-muted-foreground">
            <Layers className="h-3 w-3" />
            {t('overlapHint', { count: summary.overlap })}
          </span>
        )}
        {/* 一键顺序播放所有已合成行 */}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 gap-1 px-2 text-xs"
          disabled={summary.done + summary.overlong === 0}
          onClick={playAll}
        >
          {playingAll ? (
            <>
              <Square className="h-3 w-3" />
              {t('stopPlayAll')}
            </>
          ) : (
            <>
              <ListMusic className="h-3 w-3" />
              {t('playAll')}
            </>
          )}
        </Button>
      </div>

      {/* 虚拟列表 */}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const cue = visible[vi.index];
            const expanded = expandedIndex === cue.index;
            const isPlaybackRow = cue.index === activePlaybackIndex;
            const slotSec = cue.synthesizedMs
              ? (cue.synthesizedMs / 1000).toFixed(1)
              : null;
            return (
              <div
                key={cue.index}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className={cn(
                  'absolute left-0 top-0 w-full border-b px-2 py-1.5',
                  isPlaybackRow && 'bg-primary/5',
                  cue.status === 'overlong' && 'bg-warning/5',
                  cue.status === 'failed' && 'bg-destructive/5',
                )}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <div className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {cue.index + 1}
                  </span>
                  <button
                    className="shrink-0 text-xs tabular-nums text-muted-foreground hover:text-foreground"
                    onClick={() => onSeek?.(cue.startMs)}
                    title={t('seekToCue')}
                  >
                    {fmtTime(cue.startMs)}~{fmtTime(cue.endMs)}
                  </button>
                  <span className="shrink-0">{statusBadge(cue)}</span>
                  {cue.overlap && (
                    <Layers
                      className="h-3 w-3 shrink-0 text-muted-foreground"
                      aria-label={t('overlapTag')}
                    />
                  )}
                  <button
                    className="min-w-0 flex-1 truncate text-left text-sm hover:text-primary"
                    onClick={() => toggleExpand(cue)}
                    title={cue.text}
                  >
                    {cue.text || (
                      <span className="text-muted-foreground">∅</span>
                    )}
                  </button>

                  {cue.status === 'overlong' && cue.requiredFactor && (
                    <span className="shrink-0 rounded bg-warning/15 px-1 text-[11px] tabular-nums text-warning">
                      {cue.requiredFactor.toFixed(2)}x
                    </span>
                  )}
                  {slotSec && cue.status !== 'overlong' && (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {slotSec}s
                      {cue.appliedSpeed && cue.appliedSpeed > 1.001
                        ? ` · ${cue.appliedSpeed.toFixed(2)}x`
                        : ''}
                    </span>
                  )}

                  {/* 行级 voice 覆盖 */}
                  <Select
                    value={cue.voiceId || '__global__'}
                    onValueChange={(v) =>
                      setCueVoice(cue.index, v === '__global__' ? '' : v)
                    }
                    disabled={running || !activeEngine}
                  >
                    <SelectTrigger className="h-6 w-28 shrink-0 px-2 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-56">
                      <SelectItem value="__global__">
                        {t('voiceGlobal')}
                      </SelectItem>
                      {(activeEngine?.voices ?? []).map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    title={t('playCue')}
                    aria-label={t('playCue')}
                    disabled={!cue.wavPath}
                    onClick={() => playCue(cue.index)}
                  >
                    {playingKey === `cue-${cue.index}` ? (
                      <Square className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    title={t('regenerateCue')}
                    aria-label={t('regenerateCue')}
                    disabled={
                      running || cue.status === 'synthesizing' || !activeEngine
                    }
                    onClick={() => resynthesizeCue(cue.index)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {cue.status === 'failed' && cue.error && (
                  <p className="ml-10 mt-0.5 break-all text-xs text-destructive">
                    {cue.error}
                  </p>
                )}

                {/* 展开编辑区：改文案重合成 / 接受变速 */}
                {expanded && (
                  <div className="ml-10 mt-1.5 space-y-1.5 rounded-md border bg-muted/30 p-2">
                    <Textarea
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      rows={2}
                      className="text-sm"
                      disabled={running}
                    />
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        className="h-7"
                        disabled={running || !draftText.trim() || !activeEngine}
                        onClick={async () => {
                          await resynthesizeCue(cue.index, {
                            text: draftText,
                          });
                          setExpandedIndex(null);
                        }}
                      >
                        {t('saveAndRegenerate')}
                      </Button>
                      {cue.status === 'overlong' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-warning"
                          disabled={running}
                          onClick={async () => {
                            await acceptOverlong(cue.index);
                            setExpandedIndex(null);
                          }}
                        >
                          {t('acceptSpeedup')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        onClick={() => setExpandedIndex(null)}
                      >
                        {t('collapse')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

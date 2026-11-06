import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, {
  type Region,
} from 'wavesurfer.js/dist/plugins/regions.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.js';
import { useTranslation } from 'next-i18next';
import { Loader2, Magnet, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import type { Subtitle } from '../../hooks/useSubtitles';
import type { WaveformData } from '../../../types/waveform';
import { snapToSilence } from '../../lib/waveformEditing';

interface Props {
  videoPath: string;
  subtitles: Subtitle[];
  selectedIndex: number;
  currentTime: number;
  onSeek: (time: number, index?: number) => void;
  onTimeChange: (index: number, start: number, end: number) => string | null;
}

export default function WaveformTimeline(props: Props) {
  const { t } = useTranslation('home');
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const wave = useRef<WaveSurfer | null>(null);
  const refreshRegions = useRef<() => void>(() => {});
  const [data, setData] = useState<WaveformData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(60);
  const [snap, setSnap] = useState(true);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    const requestId = crypto.randomUUID();
    setLoading(true);
    setReady(false);
    setData(null);
    setError('');
    void window.ipc
      .invoke('proofread:waveform', { requestId, filePath: props.videoPath })
      .then((result) => {
        if (disposed) return;
        if (
          result?.success !== true ||
          !result.data?.peaks?.length ||
          !(result.data.duration > 0)
        )
          throw new Error(result?.error || 'WAVEFORM_INVALID_RESPONSE');
        setData(result.data);
      })
      .catch((cause) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      void window.ipc
        .invoke('proofread:cancel-waveform', requestId)
        .catch(() => {});
    };
  }, [props.videoPath, retry]);

  useEffect(() => {
    if (!data || !container.current) return;
    const regions = RegionsPlugin.create();
    // Precomputed peaks keep browser memory independent of decoded audio length.
    const ws = WaveSurfer.create({
      container: container.current,
      height: 104,
      peaks: [data.peaks],
      duration: data.duration,
      waveColor: '#64748b',
      progressColor: '#38bdf8',
      cursorColor: '#f59e0b',
      cursorWidth: 2,
      minPxPerSec: 60,
      autoScroll: false,
      normalize: false,
      plugins: [
        regions,
        TimelinePlugin.create({
          height: 18,
          style: { fontSize: '10px', color: '#94a3b8' },
        }),
      ],
    });
    wave.current = ws;
    setReady(false);
    setZoom(60);
    let loaded = false;
    let frame = 0;
    let dragging: { region: Region; row: Subtitle } | null = null;
    const visible = new Map<number, Region>();
    const rowStart = (row: Subtitle) => row.startTimeInSeconds ?? 0;
    const rowEnd = (row: Subtitle) => row.endTimeInSeconds ?? 0;
    const color = (index: number) =>
      index === latest.current.selectedIndex
        ? 'rgba(14,165,233,0.30)'
        : 'rgba(34,197,94,0.13)';
    const update = () => {
      if (!loaded || dragging) return;
      const width = ws.getWrapper().clientWidth;
      const start = (ws.getScroll() / width) * data.duration;
      const end = ((ws.getScroll() + ws.getWidth()) / width) * data.duration;
      const wanted = new Set<number>();
      latest.current.subtitles.forEach((row, index) => {
        if (
          rowEnd(row) < start - 1 ||
          rowStart(row) > end + 1 ||
          rowStart(row) >= data.duration ||
          rowEnd(row) <= rowStart(row)
        )
          return;
        wanted.add(index);
        let region = visible.get(index);
        if (!region) {
          region = regions.addRegion({
            id: String(index),
            start: rowStart(row),
            end: Math.min(rowEnd(row), data.duration),
            drag: false,
            resize: true,
            minLength: 0.001,
            color: color(index),
          });
          visible.set(index, region);
        } else
          region.setOptions({
            start: rowStart(row),
            end: Math.min(rowEnd(row), data.duration),
            color: color(index),
          });
        if (region.element) {
          region.element.dataset.cueIndex = String(index);
          region.element.setAttribute(
            'aria-label',
            `${index + 1}: ${row.sourceContent || ''}`,
          );
          region.element.setAttribute(
            'title',
            `${index + 1}: ${row.sourceContent || ''}`,
          );
        }
      });
      for (const [index, region] of Array.from(visible)) {
        if (!wanted.has(index)) {
          region.remove();
          visible.delete(index);
        }
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    refreshRegions.current = schedule;
    const off = [
      ws.on('ready', () => {
        loaded = true;
        setReady(true);
        schedule();
      }),
      ws.on('scroll', schedule),
      ws.on('zoom', schedule),
      ws.on('resize', schedule),
      ws.on('interaction', (time) => latest.current.onSeek(time)),
      ws.on('error', (cause) => setError(cause.message)),
      regions.on('region-clicked', (region, event) => {
        event.stopPropagation();
        const bounds = ws.getWrapper().getBoundingClientRect();
        const time = Math.max(
          0,
          Math.min(
            data.duration,
            ((event.clientX - bounds.left) / bounds.width) * data.duration,
          ),
        );
        latest.current.onSeek(time, Number(region.id));
      }),
      regions.on('region-update', (region) => {
        if (!dragging) {
          const row = latest.current.subtitles[Number(region.id)];
          if (row) dragging = { region, row };
        }
      }),
      regions.on('region-updated', (region, side) => {
        const index = Number(region.id);
        const row = latest.current.subtitles[index];
        const previous = dragging;
        dragging = null;
        if (!row || (previous && previous.row !== row)) {
          schedule();
          return;
        }
        const radius = Math.min(
          0.15,
          8 / (ws.getWrapper().clientWidth / data.duration),
        );
        let start = side === 'start' ? region.start : rowStart(row);
        let end = side === 'end' ? region.end : rowEnd(row);
        if (snapRef.current) {
          if (side === 'start')
            start = snapToSilence(start, data.silenceEdges, radius);
          if (side === 'end')
            end = snapToSilence(end, data.silenceEdges, radius);
        }
        start = Math.round(start * 1000) / 1000;
        end = Math.round(end * 1000) / 1000;
        const message = latest.current.onTimeChange(index, start, end);
        setError(message || '');
        schedule();
      }),
    ];
    return () => {
      refreshRegions.current = () => {};
      cancelAnimationFrame(frame);
      off.forEach((unsubscribe) => unsubscribe());
      ws.destroy();
      wave.current = null;
    };
  }, [data]);

  useEffect(() => {
    refreshRegions.current();
  }, [props.subtitles, props.selectedIndex]);
  useEffect(() => {
    const ws = wave.current;
    if (!ws || !ready) return;
    ws.setTime(props.currentTime);
    const start =
      (ws.getScroll() / ws.getWrapper().clientWidth) * ws.getDuration();
    const end =
      start + (ws.getWidth() / ws.getWrapper().clientWidth) * ws.getDuration();
    if (props.currentTime < start || props.currentTime > end)
      ws.setScrollTime(Math.max(0, props.currentTime - 1));
  }, [props.currentTime, ready]);

  const changeZoom = (next: number) => {
    setZoom(next);
    wave.current?.zoom(next);
  };
  return (
    <section
      aria-label={t('waveform.title')}
      className="min-w-0 shrink-0 bg-muted/30"
      data-waveform-ready={ready && !loading}
    >
      <TooltipProvider>
        <div className="flex h-9 items-center gap-1 px-2">
          <span className="mr-auto text-xs font-medium">
            {t('waveform.title')}
          </span>
          <span className="mr-2 font-mono text-xs text-muted-foreground">
            {props.currentTime.toFixed(3)} s
          </span>
          {[
            {
              name: t('waveform.zoomOut'),
              Icon: ZoomOut,
              action: () => changeZoom(Math.max(10, zoom / 2)),
              disabled: !ready || zoom <= 10,
            },
            {
              name: t('waveform.zoomIn'),
              Icon: ZoomIn,
              action: () => changeZoom(Math.min(960, zoom * 2)),
              disabled: !ready || zoom >= 960,
            },
            {
              name: t('waveform.snap'),
              Icon: Magnet,
              action: () => setSnap(!snap),
              pressed: snap,
            },
          ].map(({ name, Icon, action, disabled, pressed }) => (
            <Tooltip key={name}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={pressed ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7"
                  aria-label={name}
                  aria-pressed={pressed}
                  disabled={disabled}
                  onClick={action}
                >
                  <Icon className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{name}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
      {loading && (
        <div
          role="status"
          className="flex h-[120px] items-center justify-center gap-2 text-xs text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('waveform.loading')}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="bg-destructive/10 p-2 text-xs text-destructive"
        >
          {t('waveform.failed')}
          <details>
            <summary>{t('waveform.details')}</summary>
            <p className="break-words">{error}</p>
          </details>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            {t('waveform.retry')}
          </Button>
        </div>
      )}
      <div ref={container} className="min-w-0 overflow-hidden" />
    </section>
  );
}

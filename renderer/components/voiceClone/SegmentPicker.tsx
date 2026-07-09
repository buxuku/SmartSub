/**
 * 参考音频选段器：能量包络（canvas）+ 语音段高亮 + 可拖动选区。
 * 交互：拖两端手柄调边界、拖选区中部整体平移；时间标尺展示选区起止。
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

export interface SegmentRange {
  startMs: number;
  endMs: number;
}

const MIN_RANGE_MS = 1000;
const HANDLE_W = 10;

function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function SegmentPicker({
  envelope,
  durationMs,
  speechSegments,
  value,
  onChange,
  disabled,
}: {
  envelope: number[];
  durationMs: number;
  speechSegments: Array<{ startMs: number; endMs: number }>;
  value: SegmentRange;
  onChange: (next: SegmentRange) => void;
  disabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 画布：包络条 + 语音段底色。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || durationMs <= 0) return;
    const height = 96;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(canvas);
    const muted = styles.getPropertyValue('--muted-foreground').trim();
    const primary = styles.getPropertyValue('--primary').trim();
    const speechFill = `hsl(${primary} / 0.12)`;
    const barFill = `hsl(${muted} / 0.55)`;

    // 语音段底色。
    for (const seg of speechSegments) {
      const x = (seg.startMs / durationMs) * width;
      const w = Math.max(1, ((seg.endMs - seg.startMs) / durationMs) * width);
      ctx.fillStyle = speechFill;
      ctx.fillRect(x, 0, w, height);
    }

    // 包络条（按像素列重采样，居中对称）。
    ctx.fillStyle = barFill;
    const cols = Math.max(1, Math.floor(width / 2));
    for (let c = 0; c < cols; c += 1) {
      const from = Math.floor((c / cols) * envelope.length);
      const to = Math.max(
        from + 1,
        Math.floor(((c + 1) / cols) * envelope.length),
      );
      let peak = 0;
      for (let i = from; i < to && i < envelope.length; i += 1) {
        if (envelope[i] > peak) peak = envelope[i];
      }
      const h = Math.max(2, peak * (height - 8));
      ctx.fillRect(c * 2, (height - h) / 2, 1.4, h);
    }
  }, [envelope, speechSegments, durationMs, width]);

  // 拖动状态：'l' 左柄 / 'r' 右柄 / 'm' 平移。
  const dragRef = useRef<{
    mode: 'l' | 'r' | 'm';
    originX: number;
    origin: SegmentRange;
  } | null>(null);

  const msPerPx = durationMs / Math.max(1, width);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const deltaMs = (e.clientX - drag.originX) * msPerPx;
      let { startMs, endMs } = drag.origin;
      if (drag.mode === 'l') {
        startMs = Math.min(
          Math.max(0, startMs + deltaMs),
          endMs - MIN_RANGE_MS,
        );
      } else if (drag.mode === 'r') {
        endMs = Math.max(
          Math.min(durationMs, endMs + deltaMs),
          startMs + MIN_RANGE_MS,
        );
      } else {
        const len = endMs - startMs;
        startMs = Math.min(Math.max(0, startMs + deltaMs), durationMs - len);
        endMs = startMs + len;
      }
      onChange({ startMs: Math.round(startMs), endMs: Math.round(endMs) });
    },
    [msPerPx, durationMs, onChange],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, [onPointerMove]);

  const beginDrag = useCallback(
    (mode: 'l' | 'r' | 'm') => (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      dragRef.current = { mode, originX: e.clientX, origin: { ...value } };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endDrag);
    },
    [disabled, value, onPointerMove, endDrag],
  );

  useEffect(() => endDrag, [endDrag]);

  const leftPct = durationMs > 0 ? (value.startMs / durationMs) * 100 : 0;
  const widthPct =
    durationMs > 0 ? ((value.endMs - value.startMs) / durationMs) * 100 : 0;

  return (
    <div className="space-y-1">
      <div
        ref={containerRef}
        className="relative h-24 w-full select-none overflow-hidden rounded-md border bg-muted/20"
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {/* 选区 */}
        <div
          className="absolute inset-y-0 cursor-grab border-y-2 border-primary/70 bg-primary/15 active:cursor-grabbing"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          onPointerDown={beginDrag('m')}
        >
          <div
            className="absolute inset-y-0 left-0 flex w-2.5 cursor-ew-resize items-center justify-center bg-primary/80"
            style={{ width: HANDLE_W }}
            onPointerDown={(e) => {
              e.stopPropagation();
              beginDrag('l')(e);
            }}
          >
            <div className="h-6 w-0.5 rounded bg-primary-foreground/80" />
          </div>
          <div
            className="absolute inset-y-0 right-0 flex w-2.5 cursor-ew-resize items-center justify-center bg-primary/80"
            style={{ width: HANDLE_W }}
            onPointerDown={(e) => {
              e.stopPropagation();
              beginDrag('r')(e);
            }}
          >
            <div className="h-6 w-0.5 rounded bg-primary-foreground/80" />
          </div>
        </div>
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>0:00</span>
        <span className="font-medium text-foreground">
          {fmtTime(value.startMs)} – {fmtTime(value.endMs)}
        </span>
        <span>{fmtTime(durationMs)}</span>
      </div>
    </div>
  );
}

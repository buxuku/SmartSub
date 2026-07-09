/**
 * 参考音频选段器：能量包络（canvas）+ 语音段高亮 + 可拖动选区。
 * 长素材双视图：全览条粗调 + 选区邻域放大条精调（2.4h 课录在单条全览上
 * 拖 10s 选区一像素≈15s，无法微调——放大条把精度提到亚秒级）。
 * 放大窗口在拖动结束后跟随选区重新居中（拖动中不动，避免目标漂移）。
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'next-i18next';

export interface SegmentRange {
  startMs: number;
  endMs: number;
}

const MIN_RANGE_MS = 1000;
const HANDLE_W = 10;
/** 素材超过该时长时展示放大条。 */
const ZOOM_THRESHOLD_MS = 90_000;
/** 放大窗口 = max(选区 × 倍数, 下限)。 */
const ZOOM_SPAN_FACTOR = 4;
const ZOOM_SPAN_MIN_MS = 30_000;

function fmtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** 单条波形条：view 范围内的包络 + 语音段 + 选区拖动。 */
function WaveStrip({
  envelope,
  durationMs,
  speechSegments,
  viewStartMs,
  viewEndMs,
  value,
  onChange,
  onDragEnd,
  disabled,
  height,
}: {
  envelope: number[];
  durationMs: number;
  speechSegments: Array<{ startMs: number; endMs: number }>;
  viewStartMs: number;
  viewEndMs: number;
  value: SegmentRange;
  onChange: (next: SegmentRange) => void;
  onDragEnd?: () => void;
  disabled?: boolean;
  height: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);
  const viewSpan = Math.max(1, viewEndMs - viewStartMs);
  const binMs = durationMs / Math.max(1, envelope.length);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 画布：包络条 + 语音段底色（按 view 范围切片）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || durationMs <= 0) return;
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

    // 语音段底色（仅与 view 相交的段）。
    ctx.fillStyle = speechFill;
    for (const seg of speechSegments) {
      if (seg.endMs <= viewStartMs || seg.startMs >= viewEndMs) continue;
      const x =
        ((Math.max(seg.startMs, viewStartMs) - viewStartMs) / viewSpan) * width;
      const xEnd =
        ((Math.min(seg.endMs, viewEndMs) - viewStartMs) / viewSpan) * width;
      ctx.fillRect(x, 0, Math.max(1, xEnd - x), height);
    }

    // 包络条（按像素列在 view 的 bin 区间内取峰值）。
    ctx.fillStyle = barFill;
    const cols = Math.max(1, Math.floor(width / 2));
    const binFrom = viewStartMs / binMs;
    const binTo = viewEndMs / binMs;
    for (let c = 0; c < cols; c += 1) {
      const from = Math.floor(binFrom + (c / cols) * (binTo - binFrom));
      const to = Math.max(
        from + 1,
        Math.floor(binFrom + ((c + 1) / cols) * (binTo - binFrom)),
      );
      let peak = 0;
      for (let i = from; i < to && i < envelope.length; i += 1) {
        if (envelope[i] > peak) peak = envelope[i];
      }
      const h = Math.max(2, peak * (height - 8));
      ctx.fillRect(c * 2, (height - h) / 2, 1.4, h);
    }
  }, [
    envelope,
    speechSegments,
    durationMs,
    width,
    height,
    viewStartMs,
    viewEndMs,
    viewSpan,
    binMs,
  ]);

  // 拖动状态：'l' 左柄 / 'r' 右柄 / 'm' 平移。
  const dragRef = useRef<{
    mode: 'l' | 'r' | 'm';
    originX: number;
    origin: SegmentRange;
  } | null>(null);

  const msPerPx = viewSpan / Math.max(1, width);

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
    const wasDragging = dragRef.current !== null;
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    if (wasDragging) onDragEnd?.();
  }, [onPointerMove, onDragEnd]);

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

  const leftPct = Math.max(
    0,
    Math.min(100, ((value.startMs - viewStartMs) / viewSpan) * 100),
  );
  const rightPct = Math.max(
    0,
    Math.min(100, ((value.endMs - viewStartMs) / viewSpan) * 100),
  );
  const widthPct = Math.max(0, rightPct - leftPct);

  return (
    <div
      ref={containerRef}
      className="relative w-full select-none overflow-hidden rounded-md border bg-muted/20"
      style={{ height }}
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
  );
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
  const { t } = useTranslation('voiceClone');
  const showZoom = durationMs > ZOOM_THRESHOLD_MS;

  // 放大窗口：以选区为中心；拖动结束/外部赋值（推荐选区）时重算。
  const computeZoom = useCallback(
    (range: SegmentRange): SegmentRange => {
      const span = Math.max(
        (range.endMs - range.startMs) * ZOOM_SPAN_FACTOR,
        ZOOM_SPAN_MIN_MS,
      );
      const center = (range.startMs + range.endMs) / 2;
      let start = center - span / 2;
      let end = center + span / 2;
      if (start < 0) {
        end -= start;
        start = 0;
      }
      if (end > durationMs) {
        start -= end - durationMs;
        end = durationMs;
      }
      return {
        startMs: Math.max(0, Math.round(start)),
        endMs: Math.round(end),
      };
    },
    [durationMs],
  );

  const [zoom, setZoom] = useState<SegmentRange>(() => computeZoom(value));
  const valueRef = useRef(value);
  valueRef.current = value;
  // 自己拖动产生的 value 回流不重定位放大窗口（避免拖动中目标漂移）；
  // 外部赋值（分析完成的推荐选区/「恢复推荐」）则重新居中。
  const internalEchoRef = useRef<SegmentRange | null>(null);

  useEffect(() => {
    const echo = internalEchoRef.current;
    if (echo && echo.startMs === value.startMs && echo.endMs === value.endMs) {
      return;
    }
    internalEchoRef.current = null;
    setZoom(computeZoom(value));
  }, [value, computeZoom]);

  const handleChange = useCallback(
    (next: SegmentRange) => {
      internalEchoRef.current = next;
      onChange(next);
    },
    [onChange],
  );
  const handleDragEnd = useCallback(() => {
    internalEchoRef.current = null;
    setZoom(computeZoom(valueRef.current));
  }, [computeZoom]);

  return (
    <div className="space-y-1">
      {/* 全览条（粗调） */}
      <WaveStrip
        envelope={envelope}
        durationMs={durationMs}
        speechSegments={speechSegments}
        viewStartMs={0}
        viewEndMs={durationMs}
        value={value}
        onChange={handleChange}
        onDragEnd={handleDragEnd}
        disabled={disabled}
        height={showZoom ? 64 : 96}
      />
      <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>0:00</span>
        <span className="font-medium text-foreground">
          {fmtTime(value.startMs)} – {fmtTime(value.endMs)}
        </span>
        <span>{fmtTime(durationMs)}</span>
      </div>

      {/* 放大条（精调，长素材才出现） */}
      {showZoom && (
        <>
          <WaveStrip
            envelope={envelope}
            durationMs={durationMs}
            speechSegments={speechSegments}
            viewStartMs={zoom.startMs}
            viewEndMs={zoom.endMs}
            value={value}
            onChange={handleChange}
            onDragEnd={handleDragEnd}
            disabled={disabled}
            height={72}
          />
          <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
            <span>{fmtTime(zoom.startMs)}</span>
            <span>{t('zoomView')}</span>
            <span>{fmtTime(zoom.endMs)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 预览黑屏诊断的事件记录器：只在诊断面板挂载时运行，全部是被动监听，不改页面行为。
 *
 * 记录的事情围绕一个问题——「黑屏发生的那一刻，页面和视频各是什么状态」：
 *  - pointer：鼠标从哪个区域进入哪个区域（同时 performance.mark，Chromium 追踪里能对上）；
 *  - video：play/pause/seek/waiting/error 等事件，以及每秒的解码/丢帧/呈现帧数；
 *  - layout：视频容器与 JASSUB 画布的尺寸变化；
 *  - raf：每秒的 requestAnimationFrame 帧数与最长间隔（可选，会让页面持续出帧）；
 *  - jassub：字幕 worker 里创建 WebGL 上下文时的真实属性与 GPU 型号（诊断补丁回报）；
 *  - window/error/longtask：窗口焦点与可见性、未捕获错误、主线程长任务。
 */
import {
  changedFlags,
  diagLog,
  getPreviewDiagFlags,
} from '@/lib/previewDiagnostics';

const VIDEO_EVENTS = [
  'play',
  'pause',
  'playing',
  'waiting',
  'stalled',
  'seeking',
  'seeked',
  'emptied',
  'loadedmetadata',
  'loadeddata',
  'ratechange',
  'resize',
  'ended',
  'error',
] as const;

let region = 'unknown';
let lastPointer = { x: 0, y: 0 };

/** 鼠标当前所在区域：video / inspector / stage / hud / other。 */
export function classifyTarget(target: EventTarget | null): string {
  const el =
    typeof Element !== 'undefined' && target instanceof Element ? target : null;
  if (!el) return 'none';
  if (el.closest('[data-diag-hud]')) return 'hud';
  if (el.closest('[data-video-canvas]')) return 'video';
  return (
    el.closest('[data-diag-region]')?.getAttribute('data-diag-region') ??
    'other'
  );
}

function rectOf(el: Element | null | undefined) {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function videoState(video: HTMLVideoElement) {
  return {
    t: Math.round(video.currentTime * 1000) / 1000,
    paused: video.paused,
    ended: video.ended,
    readyState: video.readyState,
    networkState: video.networkState,
    w: video.videoWidth,
    h: video.videoHeight,
    rate: video.playbackRate,
  };
}

/** 采集「此刻」页面状态，随每次标记 / 快照一起记录。 */
export function collectContext() {
  const container = document.querySelector('[data-video-canvas]');
  const video = container?.querySelector('video') ?? null;
  const jassub =
    container?.querySelector<HTMLCanvasElement>('canvas.JASSUB') ?? null;
  return {
    flags: changedFlags(getPreviewDiagFlags()),
    region,
    pointer: lastPointer,
    container: rectOf(container),
    video: video ? { ...videoState(video), rect: rectOf(video) } : null,
    jassub: jassub
      ? {
          width: jassub.width,
          height: jassub.height,
          visibility: jassub.style.visibility,
          display: jassub.style.display,
          rect: rectOf(jassub),
        }
      : null,
    window: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      focused: document.hasFocus(),
      visibility: document.visibilityState,
    },
  };
}

/** 视频元素上的被动监听。返回清理函数。 */
export function attachDiagVideo(video: HTMLVideoElement): () => void {
  const cleanups: Array<() => void> = [];
  diagLog('video-attach', videoState(video));

  for (const name of VIDEO_EVENTS) {
    const handler = () =>
      diagLog('video', {
        ev: name,
        ...videoState(video),
        error:
          name === 'error'
            ? (video.error?.message ?? String(video.error?.code))
            : undefined,
      });
    video.addEventListener(name, handler, { passive: true });
    cleanups.push(() => video.removeEventListener(name, handler));
  }

  // 每秒汇总：实际被呈现的帧数（requestVideoFrameCallback）+ 解码质量
  let presented = 0;
  let lastMediaTime = 0;
  let callbackId = 0;
  let stopped = false;
  const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
    presented += 1;
    lastMediaTime = metadata.mediaTime;
    if (!stopped) callbackId = video.requestVideoFrameCallback(onFrame);
  };
  if (typeof video.requestVideoFrameCallback === 'function') {
    callbackId = video.requestVideoFrameCallback(onFrame);
  }
  const timer = setInterval(() => {
    const quality = video.getVideoPlaybackQuality?.();
    diagLog('video-stats', {
      presentedPerSec: presented,
      mediaTime: Math.round(lastMediaTime * 1000) / 1000,
      paused: video.paused,
      total: quality?.totalVideoFrames,
      dropped: quality?.droppedVideoFrames,
      corrupted: quality?.corruptedVideoFrames,
    });
    presented = 0;
  }, 1000);
  cleanups.push(() => {
    stopped = true;
    clearInterval(timer);
    if (callbackId) video.cancelVideoFrameCallback?.(callbackId);
  });

  return () => cleanups.forEach((cleanup) => cleanup());
}

export interface RecorderOptions {
  /** 是否采样 requestAnimationFrame（会让页面持续出帧，可能影响现象，默认关）。 */
  sampleRaf: boolean;
}

/** 启动全局记录器。返回清理函数。 */
export function startRecorder(options: RecorderOptions): () => void {
  const cleanups: Array<() => void> = [];
  const on = <T extends EventTarget>(
    target: T,
    type: string,
    handler: EventListener,
    capture = false,
  ) => {
    target.addEventListener(type, handler, { passive: true, capture });
    cleanups.push(() => target.removeEventListener(type, handler, { capture }));
  };

  diagLog('recorder-start', {
    userAgent: navigator.userAgent,
    ...collectContext(),
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
    },
  });

  // 鼠标区域：只在区域变化时记录，并打 performance.mark 供追踪对时
  on(
    document,
    'pointermove',
    ((event: PointerEvent) => {
      lastPointer = {
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
      };
      const next = classifyTarget(event.target);
      if (next === region) return;
      const previous = region;
      region = next;
      performance.mark?.(`smartsub:pointer:${next}`);
      diagLog('pointer', { from: previous, to: next, ...lastPointer });
    }) as EventListener,
    true,
  );
  on(document.documentElement, 'mouseleave', () => {
    if (region === 'outside') return;
    const previous = region;
    region = 'outside';
    diagLog('pointer', { from: previous, to: 'outside' });
  });

  // 窗口状态
  on(window, 'focus', () => diagLog('window', { ev: 'focus' }));
  on(window, 'blur', () => diagLog('window', { ev: 'blur' }));
  on(document, 'visibilitychange', () =>
    diagLog('window', { ev: 'visibility', state: document.visibilityState }),
  );
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  on(window, 'resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(
      () =>
        diagLog('window', {
          ev: 'resize',
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio,
        }),
      200,
    );
  });
  cleanups.push(() => clearTimeout(resizeTimer));
  on(window, 'pagehide', () => diagLog('window', { ev: 'pagehide' }));

  // 未捕获错误
  on(window, 'error', ((event: ErrorEvent) =>
    diagLog('error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
    })) as EventListener);
  on(window, 'unhandledrejection', ((event: PromiseRejectionEvent) =>
    diagLog('error', {
      message: String(event.reason),
      kind: 'unhandledrejection',
    })) as EventListener);

  // 视频容器尺寸变化
  const container = document.querySelector('[data-video-canvas]');
  if (container && typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() =>
      diagLog('layout', { container: rectOf(container) }),
    );
    observer.observe(container);
    cleanups.push(() => observer.disconnect());
  }

  // 主线程长任务（> 50ms）与长动画帧（> 100ms）
  for (const type of ['longtask', 'long-animation-frame']) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          diagLog(type, { duration: Math.round(entry.duration) });
        }
      });
      observer.observe({ type, buffered: false });
      cleanups.push(() => observer.disconnect());
    } catch {
      // 该类型在此 Chromium 版本里不可用
    }
  }

  // 字幕 worker 回报（诊断补丁）：WebGL 上下文真实属性、GPU 型号、上下文丢失
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('smartsub-jassub-diag');
    channel.onmessage = (event) => diagLog('jassub', { ...(event.data ?? {}) });
    cleanups.push(() => channel.close());
  }

  // rAF 采样（可选）
  if (options.sampleRaf) {
    let frames = 0;
    let maxGap = 0;
    let last = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      frames += 1;
      maxGap = Math.max(maxGap, now - last);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        diagLog('raf', { fps: frames, maxGapMs: Math.round(maxGap) });
      }
      frames = 0;
      maxGap = 0;
    }, 1000);
    cleanups.push(() => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    });
  }

  return () => cleanups.forEach((cleanup) => cleanup());
}

// ───────────────────────── 标记 / 探测 ─────────────────────────

export type MarkKind = 'black' | 'normal';

export interface LayerReading {
  ok: boolean;
  error?: string;
  file?: string;
  video: { mean: number; darkRatio: number } | null;
}

export interface MarkOutcome {
  ok: boolean;
  error?: string;
  kind: MarkKind;
  os?: LayerReading;
  viz?: LayerReading;
  verdict?: { verdict: string; text: string };
  hadBaseline: boolean;
}

/** 最近一次「画面正常」时的读数，用来排除「视频本身就是黑场」。 */
let baseline: { darkRatio: number } | null = null;

export function getBaseline(): { darkRatio: number } | null {
  return baseline;
}

/**
 * 标记「现在是黑屏 / 现在正常」，并立刻做一次三层探测：
 * 主进程依次抓系统层与合成器层的截图，算视频区域的亮度，写入日志与 PNG。
 */
export async function runMark(kind: MarkKind): Promise<MarkOutcome> {
  const hadBaseline = baseline !== null;
  const context = collectContext();
  diagLog('mark', { kind, ...context });
  const container = document.querySelector('[data-video-canvas]');
  const rect = rectOf(container);
  if (!rect) {
    return {
      ok: false,
      kind,
      hadBaseline,
      error: '没有找到视频区域，请先导入视频。',
    };
  }
  try {
    const response = await window.ipc.invoke('previewDiag:probe', {
      label: kind,
      rect,
      baseline: kind === 'black' ? baseline : null,
      context,
    });
    if (!response?.ok) {
      return {
        ok: false,
        kind,
        hadBaseline,
        error: response?.error ?? '探测失败',
      };
    }
    const os = response.os as LayerReading;
    const viz = response.viz as LayerReading;
    if (kind === 'normal') {
      const reading =
        os?.ok && os.video ? os.video : viz?.ok ? viz.video : null;
      if (reading) baseline = { darkRatio: reading.darkRatio };
    }
    return { ok: true, kind, os, viz, verdict: response.verdict, hadBaseline };
  } catch (error) {
    return {
      ok: false,
      kind,
      hadBaseline,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

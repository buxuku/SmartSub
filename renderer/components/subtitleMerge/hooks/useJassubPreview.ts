import { useCallback, useEffect, useRef, useState } from 'react';
import type JASSUB from 'jassub';
import type { SubtitleStyle } from '../../../../types/subtitleMerge';
import { useSubtitleBounds } from './useSubtitleBounds';
import {
  assEventPositionY,
  assMarginPositionY,
  absoluteSubtitleY,
} from '../../../../types/subtitleCanvas';

interface UseJassubPreviewOptions {
  videoEl: HTMLVideoElement | null;
  subtitlePath?: string | null;
  sampleText?: string;
  style: SubtitleStyle;
  currentTime?: number;
}

interface PreviewSession {
  disposed: boolean;
  instance: JASSUB | null;
  canvas: HTMLCanvasElement | null;
  fonts: Set<string>;
  embeddedKey?: string;
  queue: Promise<void>;
  failed: boolean;
  removeWorkerListeners?: () => void;
}

function destroyPreview(session: PreviewSession) {
  session.removeWorkerListeners?.();
  session.removeWorkerListeners = undefined;
  const instance = session.instance;
  session.instance = null;
  session.canvas?.remove();
  session.canvas = null;
  session.fonts.clear();
  const debug = window as unknown as Record<string, unknown>;
  if (debug.__jassubPreview === instance) delete debug.__jassubPreview;
  if (!instance) return;
  // JASSUB 2.x destroy awaits ready before terminating its worker. A failed
  // initialization must also terminate that worker, not leave it detached.
  void instance.destroy().catch(() => instance._worker?.terminate());
}

export function useJassubPreview({
  videoEl,
  subtitlePath,
  sampleText,
  style,
  currentTime = 0,
}: UseJassubPreviewOptions) {
  const sessionRef = useRef<PreviewSession | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [effectiveFont, setEffectiveFont] = useState<string | null>(null);
  const [fontSubstituted, setFontSubstituted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [translateY, setTranslateY] = useState(0);
  const bounds = useSubtitleBounds(canvas, translateY);
  const [track, setTrack] = useState<{
    resY: number;
    style: SubtitleStyle;
    events: {
      Start?: number;
      Duration?: number;
      Text?: string;
      MarginV?: number;
    }[];
  } | null>(null);
  const event = track?.events.find(
    (event) =>
      currentTime * 1000 >= (event.Start ?? 0) &&
      currentTime * 1000 < (event.Start ?? 0) + (event.Duration ?? 0),
  );
  const positionY = event
    ? (assEventPositionY(
        event.Text || '',
        track!.resY,
        currentTime * 1000 - (event.Start ?? 0),
        event.Duration ?? 0,
      ) ??
        assMarginPositionY(
          event.Text || '',
          track!.style,
          track!.resY,
          event.MarginV,
        )) +
      translateY * 100
    : undefined;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const styleKey = JSON.stringify(style);

  useEffect(() => {
    const session: PreviewSession = {
      disposed: false,
      instance: null,
      canvas: null,
      fonts: new Set(),
      queue: Promise.resolve(),
      failed: false,
    };
    sessionRef.current = session;
    setActive(false);
    setCanvas(null);
    setTranslateY(0);
    setTrack(null);
    setError(null);
    setEffectiveFont(null);
    setFontSubstituted(false);
    return () => {
      session.disposed = true;
      destroyPreview(session);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [videoEl, subtitlePath, attempt]);

  useEffect(() => {
    // An incomplete field may fail preview while typing. A new style is a new
    // request and should recover without requiring a separate retry click.
    if (sessionRef.current?.failed) setAttempt((value) => value + 1);
  }, [styleKey]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!videoEl || !session || session.failed) return;
    let cancelled = false;
    const current = () => !cancelled && !session.disposed && !session.failed;
    const fail = (cause: unknown) => {
      if (session.disposed || session.failed) return;
      session.failed = true;
      destroyPreview(session);
      setError(cause instanceof Error ? cause.message : String(cause));
      setActive(false);
      setCanvas(null);
    };
    setError(null);
    setActive(false);
    if (session.canvas) session.canvas.style.visibility = 'hidden';

    const timer = setTimeout(() => {
      // Serialize worker writes so an older slow setTrack cannot overwrite the
      // newest style. Every async boundary also checks the owning session.
      session.queue = session.queue.then(async () => {
        if (!current()) return;
        try {
          const response = await window.ipc.invoke(
            'subtitleMerge:buildPreviewAss',
            { subtitlePath: subtitlePath || null, sampleText, style },
          );
          if (!current()) return;
          if (!response?.success || typeof response.data !== 'string') {
            throw new Error(response?.error || 'Subtitle preview unavailable');
          }
          const offset = response.translateY ?? 0;
          if (!Number.isFinite(offset) || Math.abs(offset) > 1)
            throw new Error('Invalid subtitle layer translation');
          const fontName = response.fontName || style.fontName;
          const fontNames: string[] = response.fontNames || [fontName];
          const embedded: {
            fontNames: string[];
            id: string;
            data: number[];
          }[] = response.embeddedFonts || [];
          const embeddedKey = embedded
            .map((font) => `${font.fontNames.join(',')}:${font.id}`)
            .sort()
            .join('|');
          if (session.instance && session.embeddedKey !== embeddedKey)
            destroyPreview(session);
          const fonts: Uint8Array[] = [];
          if (!session.instance) {
            const seen = new Set<string>();
            for (const font of embedded) {
              if (!seen.has(font.id)) fonts.push(new Uint8Array(font.data));
              seen.add(font.id);
            }
          }
          for (const name of fontNames) {
            if (
              embedded.some((font) =>
                font.fontNames.some(
                  (family) => family.toLowerCase() === name.toLowerCase(),
                ),
              )
            )
              continue;
            if (session.fonts.has(name.toLowerCase())) continue;
            const response = await window.ipc.invoke(
              'subtitleMerge:getFontData',
              { fontName: name },
            );
            if (!current()) return;
            if (
              !response?.success ||
              !response.data?.data?.length ||
              response.data.fontName?.toLowerCase() !== name.toLowerCase()
            ) {
              throw new Error(
                response?.error || `Font unavailable: ${style.fontName}`,
              );
            }
            fonts.push(new Uint8Array(response.data.data));
            for (const variant of response.data.variants || [])
              fonts.push(new Uint8Array(variant));
          }
          let instance = session.instance;
          if (!instance) {
            const { default: JASSUBCtor } = await import('jassub');
            if (!current()) return;
            const canvas = document.createElement('canvas');
            canvas.className = 'JASSUB';
            Object.assign(canvas.style, {
              position: 'absolute',
              pointerEvents: 'none',
              visibility: 'hidden',
            });
            videoEl.insertAdjacentElement('afterend', canvas);
            session.canvas = canvas;
            // Attach video only after ready so an initialization rejection is
            // caught here instead of escaping the constructor's async setVideo.
            instance = new JASSUBCtor({
              canvas,
              subContent: response.data,
              fonts,
              defaultFont: fontName,
              queryFonts: false,
            });
            session.instance = instance;
            // JASSUB's internal video/resize callbacks do not await these promises.
            // Attach rejection observers while preserving the promise for callers.
            for (const method of ['manualRender', 'resize'] as const) {
              const original = instance[method]?.bind(instance);
              if (!original) continue;
              (instance as any)[method] = (...args: unknown[]) => {
                let pending: Promise<unknown>;
                try {
                  pending = Promise.resolve((original as any)(...args));
                } catch (cause) {
                  pending = Promise.reject(cause);
                }
                void pending.catch(fail);
                return pending;
              };
            }
            const onWorkerError = (event: ErrorEvent) =>
              fail(new Error(event.message || 'Subtitle worker failed'));
            const onMessageError = () =>
              fail(new Error('Subtitle worker message failed'));
            instance._worker?.addEventListener?.('error', onWorkerError);
            instance._worker?.addEventListener?.(
              'messageerror',
              onMessageError,
            );
            const worker = instance._worker;
            session.removeWorkerListeners = () => {
              worker?.removeEventListener?.('error', onWorkerError);
              worker?.removeEventListener?.('messageerror', onMessageError);
            };
            await instance.ready;
            if (!current()) {
              if (!session.disposed) destroyPreview(session);
              return;
            }
            await instance.setVideo(videoEl);
          } else {
            if (fonts.length) {
              await instance.renderer.addFonts(fonts);
              if (!current()) return;
            }
            await instance.renderer.setDefaultFont(fontName);
            if (!current()) return;
            await instance.renderer.setTrack(response.data);
          }
          if (!current()) return;
          setEffectiveFont(fontName);
          setFontSubstituted(
            response.fontSubstituted ?? fontName !== style.fontName,
          );
          fontNames.forEach((name) => session.fonts.add(name.toLowerCase()));
          session.embeddedKey = embeddedKey;
          if (videoEl.videoWidth && videoEl.videoHeight) {
            await instance.manualRender(
              {
                mediaTime: videoEl.currentTime,
                width: videoEl.videoWidth,
                height: videoEl.videoHeight,
                expectedDisplayTime: performance.now(),
              },
              true,
            );
          }
          if (!current()) return;
          const events = await instance.renderer.getEvents();
          if (!current()) return;
          const resY = Number(
            /^\s*PlayResY\s*:\s*(\d+)/im.exec(response.data)?.[1] || 288,
          );
          setTrack({
            events,
            resY,
            style:
              !offset && absoluteSubtitleY(style) !== undefined
                ? { ...style, marginV: 0 }
                : style,
          });
          if (session.canvas) {
            session.canvas.style.transform = offset
              ? `translateY(${offset * 100}%)`
              : '';
            session.canvas.style.visibility = 'visible';
          }
          setTranslateY(offset);
          (window as unknown as Record<string, unknown>).__jassubPreview =
            instance;
          setActive(true);
          setCanvas(session.canvas);
        } catch (cause) {
          destroyPreview(session);
          if (!current()) return;
          fail(cause);
        }
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // styleKey is the serialized value, avoiding reference-only restarts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoEl, subtitlePath, sampleText, styleKey, attempt]);

  return {
    active,
    failed: error !== null,
    error,
    retry,
    bounds,
    positionY,
    effectiveFont,
    fontSubstituted,
  };
}

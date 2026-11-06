import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import type { SubtitleStyle } from '../../../types/subtitleMerge';
import {
  ASS_PLAY_RES_X,
  ASS_PLAY_RES_Y,
  draggedSubtitleY,
  subtitleAnchor,
  type SubtitleSafeArea,
} from '../../../types/subtitleCanvas';
import { LIBASS_SRT_PLAYRES_Y } from './utils/styleUtils';
import type { SubtitleBounds } from './hooks/useSubtitleBounds';

interface Props {
  style: SubtitleStyle;
  text: string | null;
  width: number;
  height: number;
  safeArea: SubtitleSafeArea;
  renderedBounds?: SubtitleBounds | null;
  renderedPositionY?: number;
  disabled: boolean;
  onUpdateStyle: (update: Partial<SubtitleStyle>) => void;
  onPreview: (style: SubtitleStyle | null) => void;
}

export default function SubtitleCanvas({
  style,
  text,
  width,
  height,
  safeArea,
  renderedBounds,
  renderedPositionY,
  disabled,
  onUpdateStyle,
  onPreview,
}: Props) {
  const { t } = useTranslation('subtitleMerge');
  const [dragY, setDragY] = useState<number>();
  const [textWidth, setTextWidth] = useState(0);
  const drag = useRef<{
    y: number;
    style: SubtitleStyle;
    next: number;
    pointer: number;
    bounds: SubtitleBounds | null;
  } | null>(null);
  const current = dragY === undefined ? style : { ...style, positionY: dragY };
  const dragStartStyle =
    style.positionY !== undefined || renderedPositionY === undefined
      ? style
      : {
          ...style,
          positionY: renderedPositionY,
          positionReferenceY: renderedPositionY,
        };
  const anchor = subtitleAnchor(current);
  const fontSize = (style.fontSize * height) / LIBASS_SRT_PLAYRES_Y;
  const lines = (text || '').split('\n');
  const usableWidth =
    width * Math.max(0.1, 1 - (style.marginL + style.marginR) / ASS_PLAY_RES_X);
  const boxWidth = Math.max(48, Math.min(usableWidth, textWidth + 16));
  const lineCount = Math.max(
    lines.length,
    Math.ceil(textWidth / Math.max(1, usableWidth)),
  );
  const boxHeight = Math.max(
    24,
    Math.min(height, fontSize * 1.2 * lineCount + 8),
  );
  const rawLeft =
    (anchor.x / ASS_PLAY_RES_X) * width - (anchor.horizontal / 2) * boxWidth;
  const rawTop =
    (anchor.y / ASS_PLAY_RES_Y) * height - anchor.vertical * boxHeight;
  const measured = drag.current?.bounds || renderedBounds;
  const dragOffset =
    drag.current && dragY !== undefined
      ? ((dragY - draggedSubtitleY(drag.current.style, 0, height)) * height) /
        100
      : 0;
  const hitbox = measured
    ? {
        left: Math.max(0, measured.left * width - 5),
        top: Math.max(
          0,
          Math.min(
            height - measured.height * height - 10,
            measured.top * height - 5 + dragOffset,
          ),
        ),
        width: Math.min(width, measured.width * width + 10),
        height: Math.min(height, measured.height * height + 10),
      }
    : {
        left: Math.max(0, Math.min(width - boxWidth, rawLeft)),
        top: Math.max(0, Math.min(height - boxHeight, rawTop)),
        width: boxWidth,
        height: boxHeight,
      };

  useEffect(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${fontSize}px ${JSON.stringify(style.fontName)}`;
    setTextWidth(
      Math.max(
        0,
        ...(text || '')
          .split('\n')
          .map((line) => context.measureText(line).width),
      ),
    );
  }, [text, style.fontName, style.bold, style.italic, fontSize]);

  const cancel = () => {
    drag.current = null;
    setDragY(undefined);
    onPreview(null);
  };
  useEffect(() => {
    cancel();
    // A file, output mode or committed style change cancels an unfinished drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, text, style]);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      data-subtitle-canvas
    >
      {safeArea === 'broadcast' && (
        <>
          <div
            data-safe-area="90"
            className="absolute border border-dashed border-white/70"
            style={{ inset: '5%' }}
          />
          <div
            data-safe-area="80"
            className="absolute border border-dashed border-yellow-300/90"
            style={{ inset: '10%' }}
          />
        </>
      )}
      {safeArea === 'short-video' && (
        <>
          <div
            data-safe-area="actions"
            className="absolute right-0 top-[20%] bottom-[20%] w-[17%] bg-black/45 border-l border-dashed border-white/50"
          />
          <div
            data-safe-area="caption"
            className="absolute inset-x-0 bottom-0 h-[20%] bg-black/45 border-t border-dashed border-white/50"
          />
        </>
      )}
      {!!text && !disabled && width > 0 && height > 0 && (
        <button
          type="button"
          data-subtitle-drag
          aria-label={t('canvas.moveSubtitle')}
          title={t('canvas.moveSubtitle')}
          className="pointer-events-auto absolute touch-none cursor-ns-resize rounded-sm border border-dashed border-transparent bg-transparent opacity-0 outline-none hover:border-white/90 hover:opacity-100 focus-visible:border-primary focus-visible:opacity-100 group-hover/canvas:border-white/60 group-hover/canvas:opacity-100"
          style={{
            ...hitbox,
            ...(dragY !== undefined
              ? { opacity: 1, borderColor: 'white' }
              : {}),
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              y: event.clientY,
              style: dragStartStyle,
              next: draggedSubtitleY(dragStartStyle, 0, height),
              pointer: event.pointerId,
              bounds: renderedBounds || null,
            };
          }}
          onPointerMove={(event) => {
            const active = drag.current;
            if (!active || active.pointer !== event.pointerId) return;
            active.next = draggedSubtitleY(
              active.style,
              event.clientY - active.y,
              height,
            );
            setDragY(active.next);
            onPreview({ ...active.style, positionY: active.next });
          }}
          onPointerUp={(event) => {
            const active = drag.current;
            if (!active || active.pointer !== event.pointerId) return;
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            onUpdateStyle({
              positionY: active.next,
              positionReferenceY: active.style.positionReferenceY,
            });
            setDragY(undefined);
            onPreview(null);
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={() => {
            if (drag.current) cancel();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              event.stopPropagation();
              const step =
                (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? -1 : 1);
              onUpdateStyle({
                positionY: draggedSubtitleY(dragStartStyle, step, height),
                positionReferenceY: dragStartStyle.positionReferenceY,
              });
            }
          }}
        />
      )}
    </div>
  );
}

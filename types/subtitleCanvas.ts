import type { SubtitleStyle } from './subtitleMerge';
import { mapAssOverrideBlocks } from './assOverrides';

export const ASS_PLAY_RES_X = 384;
export const ASS_PLAY_RES_Y = 288;
export type SubtitleSafeArea = 'none' | 'short-video' | 'broadcast';

export function absoluteSubtitleY(style: SubtitleStyle): number | undefined {
  return typeof style.positionY === 'number' && Number.isFinite(style.positionY)
    ? Math.max(0, Math.min(100, style.positionY))
    : undefined;
}

/** ASS \pos uses the alignment's edge/center as its anchor, not the text's center. */
export function subtitleAnchor(style: SubtitleStyle) {
  const column = (style.alignment - 1) % 3;
  const row = Math.floor((style.alignment - 1) / 3);
  const x =
    column === 0
      ? style.marginL
      : column === 1
        ? ASS_PLAY_RES_X / 2
        : ASS_PLAY_RES_X - style.marginR;
  const explicitY = absoluteSubtitleY(style);
  const y =
    explicitY !== undefined
      ? (explicitY * ASS_PLAY_RES_Y) / 100
      : row === 0
        ? ASS_PLAY_RES_Y - style.marginV
        : row === 1
          ? ASS_PLAY_RES_Y / 2
          : style.marginV;
  return {
    x,
    y,
    horizontal: column,
    vertical: row === 0 ? 1 : row === 1 ? 0.5 : 0,
  };
}

export function draggedSubtitleY(
  style: SubtitleStyle,
  deltaPixels: number,
  frameHeight: number,
): number {
  const current = (subtitleAnchor(style).y / ASS_PLAY_RES_Y) * 100;
  const moved =
    frameHeight > 0 && Number.isFinite(deltaPixels)
      ? current + (deltaPixels / frameHeight) * 100
      : current;
  return Math.round(Math.max(0, Math.min(100, moved)) * 1000) / 1000;
}

export function assEventAlignment(
  text: string,
  fallback: SubtitleStyle['alignment'],
): SubtitleStyle['alignment'] {
  let alignment = fallback;
  mapAssOverrideBlocks(text, (tag) => {
    const align = /^\\an([1-9])\s*$/i.exec(tag);
    const legacy = /^\\a(\d+)\s*$/i.exec(tag);
    if (align) alignment = Number(align[1]) as SubtitleStyle['alignment'];
    else if (legacy) {
      const mapped = { 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 }[
        Number(legacy[1])
      ];
      if (mapped) alignment = mapped as SubtitleStyle['alignment'];
    }
    return tag;
  });
  return alignment;
}

export function assMarginPositionY(
  text: string,
  style: SubtitleStyle,
  resY: number,
  eventMarginV = 0,
): number {
  const row = Math.floor((assEventAlignment(text, style.alignment) - 1) / 3);
  const margin = eventMarginV !== 0 ? eventMarginV : style.marginV;
  return (
    ((row === 0 ? resY - margin : row === 1 ? resY / 2 : margin) / resY) * 100
  );
}

/** Absolute anchor in a rendered ASS event, including timed movement. */
export function assEventPositionY(
  text: string,
  playResY: number,
  elapsedMs: number,
  durationMs: number,
): number | undefined {
  if (!(playResY > 0)) return undefined;
  let position: number | undefined;
  mapAssOverrideBlocks(text, (tag) => {
    if (position !== undefined) return tag;
    const match = /^\\(pos|move)\(([^)]*)\)\s*$/i.exec(tag);
    if (!match) return tag;
    const values = match[2].split(',').map((value) => Number(value.trim()));
    if (!values.every(Number.isFinite)) return tag;
    if (match[1].toLowerCase() === 'pos' && values.length === 2)
      position = (values[1] / playResY) * 100;
    if (match[1].toLowerCase() === 'move' && [4, 6].includes(values.length)) {
      const start = values.length === 6 ? values[4] : 0;
      const end = values.length === 6 ? values[5] : durationMs;
      const ratio =
        end > start
          ? Math.max(0, Math.min(1, (elapsedMs - start) / (end - start)))
          : Number(elapsedMs >= end);
      position =
        ((values[1] + (values[3] - values[1]) * ratio) / playResY) * 100;
    }
    return tag;
  });
  return position;
}

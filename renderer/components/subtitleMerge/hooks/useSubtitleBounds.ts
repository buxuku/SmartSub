import { useEffect, useState } from 'react';

export interface SubtitleBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function alphaBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): SubtitleBounds | null {
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 16) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0
    ? null
    : {
        left: left / width,
        top: top / height,
        width: (right - left + 1) / width,
        height: (bottom - top + 1) / height,
      };
}

/** Alpha bounds of the actual libass output, in normalized video coordinates. */
export function useSubtitleBounds(
  canvas: HTMLCanvasElement | null,
  translateY = 0,
) {
  const [bounds, setBounds] = useState<SubtitleBounds | null>(null);
  useEffect(() => {
    setBounds(null);
    if (!canvas) return;
    const sample = document.createElement('canvas');
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    let frame = 0;
    let previousTime = -Infinity;
    const measure = (time: number) => {
      frame = requestAnimationFrame(measure);
      // Downsample and cap readback frequency; never scan a full 4K video frame.
      if (time - previousTime < 100 || !canvas.width || !canvas.height) return;
      previousTime = time;
      const scale = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
      const width = Math.max(1, Math.round(canvas.width * scale));
      const height = Math.max(1, Math.round(canvas.height * scale));
      if (sample.width !== width || sample.height !== height) {
        sample.width = width;
        sample.height = height;
      }
      try {
        context.clearRect(0, 0, width, height);
        context.drawImage(canvas, 0, translateY * height, width, height);
        const { data } = context.getImageData(0, 0, width, height);
        const next = alphaBounds(data, width, height);
        setBounds((previous) =>
          JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
        );
      } catch {
        setBounds(null);
      }
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [canvas, translateY]);
  return bounds;
}

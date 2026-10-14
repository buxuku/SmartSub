/**
 * 位图亮度统计（纯函数）。
 *
 * 用来把「截图里这块区域是不是黑的」变成数字：黑屏时平均亮度接近 0、暗像素占比接近 1。
 * 同一时刻对「视频帧本身 / Chromium 合成器截图 / 操作系统窗口截图」各算一份，
 * 三者的差异直接指出黑屏发生在哪一层。
 */

export interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LumaStats {
  /** 参与统计的区域（像素，已裁剪到位图范围内） */
  region: PixelRegion;
  samples: number;
  /** 0-255，Rec.709 亮度的平均值 */
  mean: number;
  min: number;
  max: number;
  /** 亮度低于 DARK_LUMA 的采样占比，0-1 */
  darkRatio: number;
}

/** 低于它就算「几乎纯黑」。视频黑场也可能低于它，所以要和别的层对比着看。 */
export const DARK_LUMA = 12;

export type ChannelOrder = 'bgra' | 'rgba';

/**
 * 统计位图中某个区域的亮度。
 * @param step 每隔多少个像素取一个样（行列同步），默认 4：大图也只扫 1/16 的像素。
 * @returns 区域裁剪后为空、或位图数据长度对不上时返回 null。
 */
export function lumaStats(
  bitmap: Uint8Array,
  width: number,
  height: number,
  region?: PixelRegion,
  order: ChannelOrder = 'bgra',
  step = 4,
): LumaStats | null {
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) {
    return null;
  }
  const x0 = Math.max(0, Math.floor(region?.x ?? 0));
  const y0 = Math.max(0, Math.floor(region?.y ?? 0));
  const x1 = Math.min(
    width,
    Math.ceil((region?.x ?? 0) + (region?.width ?? width)),
  );
  const y1 = Math.min(
    height,
    Math.ceil((region?.y ?? 0) + (region?.height ?? height)),
  );
  if (x1 <= x0 || y1 <= y0) return null;

  const stride = Math.max(1, Math.floor(step));
  const rOffset = order === 'bgra' ? 2 : 0;
  const bOffset = order === 'bgra' ? 0 : 2;
  let sum = 0;
  let min = 255;
  let max = 0;
  let dark = 0;
  let samples = 0;
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const index = (y * width + x) * 4;
      const luma =
        0.2126 * bitmap[index + rOffset] +
        0.7152 * bitmap[index + 1] +
        0.0722 * bitmap[index + bOffset];
      sum += luma;
      if (luma < min) min = luma;
      if (luma > max) max = luma;
      if (luma < DARK_LUMA) dark += 1;
      samples += 1;
    }
  }
  if (samples === 0) return null;
  return {
    region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    samples,
    mean: round(sum / samples),
    min: round(min),
    max: round(max),
    darkRatio: round(dark / samples, 4),
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

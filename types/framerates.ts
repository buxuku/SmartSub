/**
 * 广播级标准帧率与零漂移换算定义（Main 与 Renderer 共享类型与常量）
 *
 * 消除 23.976 fps 等 NTSC 帧率因简单浮点估算（如 24/25 = 0.96）累积的毫秒级时间轴漂移。
 * 1 小时 23.976 fps 视频使用 24/25 会累积约 3.45 秒偏差；使用 24000/1001 精确分数比为 0 毫秒漂移。
 */

/** NTSC 23.976 (24000 / 1001) */
export const FPS_23_976 = 24000 / 1001;

/** NTSC 29.97 (30000 / 1001) */
export const FPS_29_97 = 30000 / 1001;

/** NTSC 59.94 (60000 / 1001) */
export const FPS_59_94 = 60000 / 1001;

/** 电影标准 24 fps */
export const FPS_24 = 24;

/** PAL 电视标准 25 fps */
export const FPS_25 = 25;

/** 30 fps */
export const FPS_30 = 30;

/** 60 fps */
export const FPS_60 = 60;

export interface FramerateRatioPreset {
  label: string;
  description?: string;
  ratio: number;
  fraction: { numerator: number; denominator: number };
}

/**
 * 标准帧率缩放比率预设（精确无损分数）
 * scaleRatio = targetDuration / sourceDuration = sourceFps / targetFps
 * 当视频从 23.976 转为 25 fps 时，画面播放变快，字幕时间轴需相应乘 (24000/1001) / 25 = 960 / 1001
 */
export const FRAMERATE_RATIO_PRESETS: readonly FramerateRatioPreset[] = [
  {
    label: '23.976 → 25 fps',
    description: 'NTSC 23.976 fps 转 PAL 25 fps (960 / 1001)',
    ratio: 960 / 1001, // (24000 / 1001) / 25
    fraction: { numerator: 960, denominator: 1001 },
  },
  {
    label: '25 → 23.976 fps',
    description: 'PAL 25 fps 转 NTSC 23.976 fps (1001 / 960)',
    ratio: 1001 / 960, // 25 / (24000 / 1001)
    fraction: { numerator: 1001, denominator: 960 },
  },
  {
    label: '24 → 23.976 fps',
    description: '标准 24 fps 转 23.976 fps (1001 / 1000)',
    ratio: 1001 / 1000,
    fraction: { numerator: 1001, denominator: 1000 },
  },
  {
    label: '23.976 → 24 fps',
    description: '23.976 fps 转标准 24 fps (1000 / 1001)',
    ratio: 1000 / 1001,
    fraction: { numerator: 1000, denominator: 1001 },
  },
  {
    label: '29.97 → 25 fps',
    description: 'NTSC 29.97 fps 转 PAL 25 fps (1200 / 1001)',
    ratio: 1200 / 1001, // (30000 / 1001) / 25
    fraction: { numerator: 1200, denominator: 1001 },
  },
  {
    label: '59.94 → 60 fps',
    ratio: 1000 / 1001,
    fraction: { numerator: 1000, denominator: 1001 },
  },
  {
    label: '恢复 1.0',
    description: '重置为原始比率',
    ratio: 1.0,
    fraction: { numerator: 1, denominator: 1 },
  },
] as const;

/** Scale each original timestamp independently; round once at the file's ms boundary. */
export function scaleTimestampMs(
  ms: number,
  fraction: { numerator: number; denominator: number },
): number {
  const { numerator, denominator } = fraction;
  if (
    !Number.isSafeInteger(ms) ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    throw new Error('Invalid rational timestamp or frame rate');
  }
  const product = BigInt(ms) * BigInt(numerator);
  const divisor = BigInt(denominator);
  const positive = product >= BigInt(0);
  const magnitude = positive ? product : -product;
  const rounded = (magnitude * BigInt(2) + divisor) / (divisor * BigInt(2));
  const result = Number(positive ? rounded : -rounded);
  if (!Number.isSafeInteger(result))
    throw new Error('Timestamp exceeds integer precision');
  return result;
}

/**
 * 字幕合并功能相关类型定义
 */

/**
 * 字幕对齐位置 (numpad 风格的 9 宫格)
 * 7=左上, 8=中上, 9=右上
 * 4=左中, 5=居中, 6=右中
 * 1=左下, 2=中下, 3=右下
 */
export type SubtitleAlignment = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * 边框样式
 * 1 = 边框 + 阴影
 * 3 = 不透明背景框
 */
export type BorderStyle = 1 | 3;

/**
 * 字幕样式配置
 * 所有颜色使用 CSS 格式 (#RRGGBB 或 rgba)
 */
export interface SubtitleStyle {
  /** 字体名称 */
  fontName: string;
  /** 字体大小 (10-72) */
  fontSize: number;
  /** 主要颜色 (CSS 格式) */
  primaryColor: string;
  /** 边框颜色 (CSS 格式) */
  outlineColor: string;
  /** 背景/阴影颜色 (CSS 格式) */
  backColor: string;
  /**
   * 背景不透明度（0-100，百分比）。缺省按 50 处理（≈旧版硬编码 alpha=128）。
   * ASS alpha 语义反转：assAlpha = round((1 - backOpacity/100) * 255)，00=不透明 FF=全透明。
   */
  backOpacity?: number;
  /** 是否加粗 */
  bold: boolean;
  /** 是否斜体 */
  italic: boolean;
  /** 是否下划线 */
  underline: boolean;
  /** 边框样式 */
  borderStyle: BorderStyle;
  /** 边框宽度 (0-10) */
  outline: number;
  /** 阴影距离 (0-10) */
  shadow: number;
  /** 对齐位置 */
  alignment: SubtitleAlignment;
  /** 左边距 (px) */
  marginL: number;
  /** 右边距 (px) */
  marginR: number;
  /** 上下边距 (px) */
  marginV: number;
}

/**
 * 预设样式配置
 */
export interface StylePreset {
  /** 预设 ID */
  id: string;
  /** 预设名称 */
  name: string;
  /** 国际化 key */
  nameKey: string;
  /** 样式配置 */
  style: SubtitleStyle;
}

/**
 * 输出方式
 * hardcode = 烧录硬字幕（重编码，所有播放器可见）
 * softmux = 封装软字幕（mkv 容器，秒级无损，播放器可开关）
 */
export type MergeOutputMode = 'hardcode' | 'softmux';

/**
 * 硬字幕烧录的导出画质（仅 hardcode 生效；softmux 直接流复制无损，不受此影响）。
 * 烧录必然重编码，画质由 libx264 CRF 决定：值越小越接近原画质、体积越大。
 * - original = 原画质（CRF 18，视觉无损，体积接近源文件）
 * - high     = 高画质（CRF 20）
 * - standard = 标准（CRF 23，等同旧版默认行为，体积更小）
 */
export type VideoQuality = 'original' | 'high' | 'standard';

/** 各画质档位对应的 libx264 CRF 值。 */
export const VIDEO_QUALITY_CRF: Record<VideoQuality, number> = {
  original: 18,
  high: 20,
  standard: 23,
};

/**
 * 合并配置
 */
export interface MergeConfig {
  /** 视频文件路径 */
  videoPath: string;
  /** 字幕文件路径 */
  subtitlePath: string;
  /** 输出文件路径 */
  outputPath: string;
  /** 字幕样式 */
  style: SubtitleStyle;
  /** 输出方式（缺省 hardcode，向后兼容） */
  outputMode?: MergeOutputMode;
  /** 硬字幕烧录画质（缺省 original；仅 hardcode 生效） */
  videoQuality?: VideoQuality;
}

/**
 * 合并状态
 */
export type MergeStatus = 'idle' | 'processing' | 'completed' | 'error';

/**
 * 合并进度信息
 */
export interface MergeProgress {
  /** 进度百分比 (0-100) */
  percent: number;
  /** 当前处理时间点 */
  timeMark: string;
  /** 目标文件大小 (KB) */
  targetSize: number;
  /** 当前状态 */
  status: MergeStatus;
  /** 错误消息 */
  errorMessage?: string;
}

/**
 * 视频信息
 */
export interface VideoInfo {
  /** 视频路径 */
  path: string;
  /** 文件名 */
  fileName: string;
  /** 时长 (秒) */
  duration: number;
  /** 宽度 */
  width: number;
  /** 高度 */
  height: number;
  /** 文件大小 (bytes) */
  size: number;
}

/**
 * 字幕文件信息
 */
export interface SubtitleInfo {
  /** 字幕路径 */
  path: string;
  /** 文件名 */
  fileName: string;
  /** 字幕条数 */
  count: number;
  /** 格式 (srt, ass, vtt) */
  format: string;
}

/**
 * IPC 响应格式
 */
export interface SubtitleMergeResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** 操作被用户取消（不算失败） */
  cancelled?: boolean;
}

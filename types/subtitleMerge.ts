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
 * 编码方式（仅 hardcode 生效）：
 * - cpu      = libx264 软件编码（默认，体积更小）
 * - hardware = 硬件加速编码（速度更快，同等观感体积通常增大 30%~100%）
 */
export type EncoderMode = 'cpu' | 'hardware';

/** 支持的硬件编码器 ID（第一期：mac VideoToolbox；win NVENC/QSV；AMF、Linux 后续迭代） */
export type HwEncoderId = 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv';

/**
 * 硬件编码器质量控制方式：
 * - cq      = 恒定质量参数（各编码器语义见 HW_QUALITY_MAPPING）
 * - bitrate = 目标码率模式（仅 Intel Mac VideoToolbox：不支持 -q:v，按源码率估算）
 */
export type HwRateMode = 'cq' | 'bitrate';

/** 硬件编码器探测结果（IPC subtitleMerge:getHwAccelInfo 返回） */
export interface HwAccelInfo {
  /** 本机存在可用硬件编码器 */
  available: boolean;
  /** 可用编码器 ID（available=true 时存在） */
  encoderId?: HwEncoderId;
  /** 展示用编码器名称，如 "NVIDIA NVENC" */
  encoderLabel?: string;
  /** 质量控制方式（available=true 时存在） */
  rateMode?: HwRateMode;
  /** 平台层面是否支持硬件加速（linux=false，UI 据此隐藏整个控件） */
  platformSupported: boolean;
}

/**
 * 硬件编码器画质档位映射（初值，实现期在真实素材上校准，允许 ±2 微调）。
 * CQ 值相对 libx264 CRF 整体 +1：牺牲少量画质换体积贴近，缓解硬件编码体积膨胀。
 * fourKAdjustment 与 libx264 的 4K CRF+2 语义等价（VideoToolbox q:v 量纲反向故为负）。
 */
export const HW_QUALITY_MAPPING: Record<
  HwEncoderId,
  {
    /** 各画质档位的恒定质量参数值 */
    cq: Record<VideoQuality, number>;
    /** 4K（高度≥1800）时在档位值上的偏移 */
    fourKAdjustment: number;
  }
> = {
  // -rc vbr -cq N -b:v 0 -preset p5
  h264_nvenc: {
    cq: { original: 19, high: 21, standard: 24 },
    fourKAdjustment: 2,
  },
  // -global_quality N（ICQ 模式）
  h264_qsv: {
    cq: { original: 19, high: 21, standard: 24 },
    fourKAdjustment: 2,
  },
  // -q:v N（1-100，越大越好，仅 Apple Silicon；Intel 走码率模式）
  h264_videotoolbox: {
    cq: { original: 65, high: 58, standard: 50 },
    fourKAdjustment: -5,
  },
};

/**
 * VideoToolbox 码率模式（Intel Mac）各档位的源码率系数。
 * 目标视频码率 = 估算源视频码率 × 系数（源码率估算含 0.85 音频扣除，见 subtitleMerger）。
 */
export const VT_BITRATE_QUALITY_FACTOR: Record<VideoQuality, number> = {
  original: 1.0,
  high: 0.85,
  standard: 0.65,
};

// ── 统一合成引擎（compose）：字幕 × 音轨矩阵 ────────────────────────────────

/**
 * 合成字幕维度：
 * - none = 不处理字幕
 * - soft = 软字幕封装（流复制进 mkv，播放器可开关）
 * - hard = 硬字幕烧录（重编码视频）
 */
export type ComposeSubtitleMode = 'none' | 'soft' | 'hard';

/**
 * 合成音轨维度：
 * - keep     = 保留原声（流复制）
 * - replace  = 配音轨替换原声
 * - mix      = 配音 + 原声压低混音（ducking）
 * - addTrack = mkv 新增音轨（原声 + 配音双轨）
 */
export type ComposeAudioMode = 'keep' | 'replace' | 'mix' | 'addTrack';

export type ComposeSubtitleSpec =
  | { mode: 'none' }
  | { mode: 'soft'; subtitlePath: string }
  | {
      mode: 'hard';
      subtitlePath: string;
      style: SubtitleStyle;
      videoQuality?: VideoQuality;
      encoderMode?: EncoderMode;
    };

export type ComposeAudioSpec =
  | { mode: 'keep' }
  | {
      mode: 'replace' | 'mix' | 'addTrack';
      /** 配音音轨文件（wav/mp3/m4a 等音频） */
      trackPath: string;
      /** mix 模式的原声压低强度（sidechaincompress ratio，缺省 8） */
      duckRatio?: number;
    };

/**
 * 统一合成作业配置：一次 ffmpeg 执行完成「字幕 × 音轨」组合。
 * 约束：subtitle=none 且 audio=keep 为无效作业（无处理内容）；
 * soft 或 addTrack 参与时输出容器必须为 mkv（见 composeRequiresMkv）。
 */
export interface ComposeConfig {
  videoPath: string;
  outputPath: string;
  subtitle: ComposeSubtitleSpec;
  audio: ComposeAudioSpec;
}

/** soft 字幕轨与双音轨均依赖 mkv 容器（mp4 系不支持 srt 字幕流/多轨语义受限） */
export function composeRequiresMkv(config: {
  subtitle: { mode: ComposeSubtitleMode };
  audio: { mode: ComposeAudioMode };
}): boolean {
  return config.subtitle.mode === 'soft' || config.audio.mode === 'addTrack';
}

/** 合成作业来源（队列 UI 展示与取消定位用） */
export type ComposeJobSource = 'subtitleMerge' | 'dubbingExport' | 'pipeline';

export type ComposeJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled';

/** 队列快照中的作业视图（渲染层展示排队状态 + 页面重开时重连上下文） */
export interface ComposeJobView {
  id: string;
  status: ComposeJobStatus;
  source: ComposeJobSource;
  outputPath: string;
  createdAt: number;
  error?: string;
  /** 重连上下文：合成页重挂载时据此恢复文件区与进行中状态 */
  videoPath: string;
  subtitlePath?: string;
  subtitleMode: ComposeSubtitleMode;
  audioTrack?: {
    mode: 'replace' | 'mix' | 'addTrack';
    trackPath: string;
  };
}

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
  /**
   * 编码方式（缺省 cpu，向后兼容；仅 hardcode 生效）。
   * hardware 时主进程按探测缓存解析具体编码器；探测不可用则自动走 libx264。
   */
  encoderMode?: EncoderMode;
  /**
   * 可选配音音轨（合成矩阵的音轨维度）：缺省保留原声，行为与引入前一致。
   * addTrack 模式输出容器必须为 mkv。
   */
  audioTrack?: {
    mode: 'replace' | 'mix' | 'addTrack';
    trackPath: string;
    /** mix 模式原声压低强度（缺省 8） */
    duckRatio?: number;
  };
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
  /** 硬件编码失败已自动切换 CPU 重试（渲染层据此提示） */
  hwFallback?: boolean;
  /** 所属合成作业（队列化后增量携带；既有消费方可忽略） */
  jobId?: string;
  /** 作业来源（渲染层按来源过滤各自面板的进度） */
  source?: ComposeJobSource;
  /** 作业排队中：前方还有 N 个作业（>0 时为排队等待态） */
  queuedAhead?: number;
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

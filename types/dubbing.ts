/**
 * TTS 配音功能类型定义（配音工作台 / 对齐引擎 / 配音管线共用）。
 *
 * 纯类型/常量（不依赖 electron / fs），main、renderer、test:dubbing 均可直接引入。
 * cue 的时间轴字段与 main/helpers/subtitleFormats.ts 的 SubtitleCue 结构兼容
 * （startMs/endMs/text），types 层不反向依赖 main。
 */

/** 配音行状态（行级列表用）。 */
export type DubbingCueStatus =
  | 'pending' // 待合成
  | 'synthesizing' // 合成中
  | 'done' // 完成（落在槽位内）
  | 'overlong' // 过长警告（所需倍率超红线，待人工处理）
  | 'accepted' // 过长但用户已确认「接受变速」
  | 'failed'; // 合成失败，可重试

/** 一条配音 cue = 字幕 cue + 配音扩展。 */
export interface DubbingCue {
  /** 行号（0-based），会话内稳定标识。 */
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  /**
   * 行级 voice 覆盖；缺省用全局 voice。
   * D2：v1 仅手动指定，此字段同时为将来自动说话人分离预留。
   */
  voiceId?: string;
  status: DubbingCueStatus;
  /** 与相邻 cue 时间轴交叠（重叠告警，v1 按 start 顺延消解）。 */
  overlap?: boolean;
  /** 实测合成时长（ms，合成后回填，替代预估值参与复测决策）。 */
  synthesizedMs?: number;
  /** 已生效的综合变速倍率（1 = 原速；含预控制与后处理的乘积）。 */
  appliedSpeed?: number;
  /** 合成产物 wav 路径（行级回放用）。 */
  wavPath?: string;
  /** 失败原因（status = 'failed' 时）。 */
  error?: string;
}

/** 引擎选择：本地 sherpa 模型或云端服务商实例。 */
export type DubbingEngineSelection =
  | { kind: 'local'; modelId: string }
  | { kind: 'cloud'; providerId: string };

/** 背景音处理（D3：v1 两选项；人声/伴奏分离 v2）。 */
export type DubbingBackgroundMode = 'mute' | 'duck';

/** 输出形态（无视频输入时仅 audioOnly 可用）。 */
export type DubbingOutputMode =
  | 'audioOnly' // 仅音频（wav/mp3）
  | 'replaceTrack' // 替换音轨的视频
  | 'mixTrack' // ducking 混音视频（保留压低的原轨）
  | 'addTrack'; // mkv 新增音轨（原轨 + 配音轨双音轨）

/** 仅音频输出的封装格式。 */
export type DubbingAudioFormat = 'wav' | 'mp3';

/** 兜底后仍超长的行的处置（用户选项）。 */
export type DubbingOverflowMode = 'truncate' | 'shift';

/** 配音工作台全局配置（userConfig 记忆）。 */
export interface DubbingConfig {
  engine: DubbingEngineSelection;
  /** 全局默认 voice（可被行级 voiceId 覆盖）。 */
  voice: string;
  /** 整体语速（1 = 原速），叠加在对齐引擎的行级变速之上。 */
  globalSpeed: number;
  background: DubbingBackgroundMode;
  output: DubbingOutputMode;
  /** output = 'audioOnly' 时生效。 */
  audioFormat?: DubbingAudioFormat;
  /** 兜底后仍超长的行截断还是顺延（默认截断）。 */
  overflow?: DubbingOverflowMode;
  /** 同时导出时间轴顺延版字幕（纯音频输出场景有用）。 */
  exportShiftedSubtitle?: boolean;
}

// ── 对齐引擎（alignment.ts 纯函数的输入输出合同）────────────────────────────

/** ratio 决策树阈值（design 定稿：6.3 单条字幕的决策树）。 */
export const ALIGN_PRE_SPEED_THRESHOLD = 1.0; // ≤1.0 原速
export const ALIGN_ONESHOT_THRESHOLD = 1.15; // ≤1.15 预控制一次到位
export const ALIGN_OVERLONG_THRESHOLD = 1.5; // >1.5 过长行进人工清单

/** 行级变速动作。 */
export type AlignmentSpeedAction =
  | { type: 'none' }
  | { type: 'preSpeed'; speed: number } // 合成期 speed 预控制
  | { type: 'atempo'; factor: number }; // 后处理变速（云端复测分支）

/** 单条 cue 的槽位规划。 */
export interface AlignmentPlanItem {
  index: number;
  /** 拼接时间轴上的目标起点（ms；顺延后可能晚于原 startMs）。 */
  targetStartMs: number;
  /** 该条配音在音轨上的实际占用时长（ms，截断后）。 */
  durationMs: number;
  /** 可用槽位（ms，含间隙借用：本条 start 到下条 start）。 */
  slotMs: number;
  /** 预估（或实测）时长 / 可用槽位。 */
  ratio: number;
  action: AlignmentSpeedAction;
  /** 尾部补静音（ms，短于槽位时）。 */
  padMs: number;
  /** 所需倍率超红线，进人工兜底清单。 */
  overlong: boolean;
  /** 与相邻 cue 时间轴交叠（已按 start 顺延消解）。 */
  overlap: boolean;
}

/** 对齐引擎输出：完整槽位规划，可直接驱动拼接器。 */
export interface AlignmentPlan {
  items: AlignmentPlanItem[];
  /** 过长行 index 清单（= items 中 overlong 的行，冗余汇总供 UI 直取）。 */
  overlongIndexes: number[];
  /** 重叠行 index 清单。 */
  overlapIndexes: number[];
}

// ── 进度事件（dubbing: IPC 推送）────────────────────────────────────────────

/** 管线阶段。 */
export type DubbingStage =
  | 'parse' // 解析字幕
  | 'synthesize' // 逐条合成
  | 'align' // 对齐复测
  | 'concat' // 拼接音轨
  | 'mux' // 背景音处理与输出封装
  | 'done';

/** 行级进度事件载荷。 */
export interface DubbingProgressEvent {
  taskId: string;
  stage: DubbingStage;
  /** 整体百分比 0..100。 */
  percent: number;
  /** 当前行（synthesize/align 阶段）。 */
  cueIndex?: number;
  /** 行状态变更（增量更新 UI 行列表）。 */
  cueStatus?: DubbingCueStatus;
}

// ── 渲染层视图（dubbing: IPC 的 data 形状）──────────────────────────────────

/** 行视图（main 侧 SessionCue 经 cueView 投影）。 */
export interface DubbingCueView {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  voiceId?: string;
  status: DubbingCueStatus;
  overlap: boolean;
  /** 实测最终时长（ms）。 */
  synthesizedMs?: number;
  /** 对齐层施加的综合额外倍率（不含整体语速）。 */
  appliedSpeed?: number;
  /** 过长行所需综合倍率。 */
  requiredFactor?: number;
  /** 行级合成产物（media:// 回放）。 */
  wavPath?: string;
  error?: string;
}

/** dubbing:loadSubtitle 返回。 */
export interface DubbingSessionView {
  sessionId: string;
  subtitlePath: string;
  videoPath?: string;
  mediaDurationMs: number;
  cues: DubbingCueView[];
}

/** dubbing:progress 事件载荷（含可选行快照）。 */
export interface DubbingProgressPayload extends DubbingProgressEvent {
  cue?: DubbingCueView;
}

/** dubbing:start 返回。 */
export interface DubbingBatchView {
  doneCount: number;
  overlongIndexes: number[];
  overlapIndexes: number[];
  failedIndexes: number[];
  cancelled?: boolean;
  cues: DubbingCueView[];
}

/** dubbing:export 返回。 */
export interface DubbingExportView {
  outputPath: string;
  shiftedSubtitlePath?: string;
  skippedIndexes: number[];
}

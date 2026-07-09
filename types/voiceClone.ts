/**
 * 声音克隆（我的音色）类型定义（创建向导 / 质检管线 / 音色管理共用）。
 *
 * 纯类型/常量（不依赖 electron / fs），main、renderer、test:dubbing 均可直接引入。
 */

/** 克隆引擎：本地 zipvoice 零样本 / 火山复刻 2.0 云端训练。 */
export type VoiceCloneEngine = 'zipvoice' | 'volcengine';

/** 云端训练状态（zipvoice 即建即用，无此状态）。 */
export type VoiceCloneTrainStatus = 'training' | 'ready' | 'failed';

/** 用户创建的克隆音色实体（store 键 `clonedVoices`）。 */
export interface ClonedVoice {
  /** `cv_<uuid>`，跨引擎稳定标识（工作台 voiceId 用 `clone:<id>` 前缀引用）。 */
  id: string;
  name: string;
  engine: VoiceCloneEngine;
  /** 参考音频语言（zipvoice 双语模型支持 zh/en；火山按训练语种）。 */
  language: 'zh' | 'en';
  /** zipvoice：处理后参考音频（userData/voiceClones/<id>/ref.wav）。 */
  refWavPath?: string;
  /** zipvoice：参考音频的精确转写文本（与音频不匹配会明显劣化）。 */
  refText?: string;
  /** 火山：控制台购买的音色槽位 id（S_ 开头）。 */
  speakerId?: string;
  /** 火山：绑定的豆包 TTS provider 实例 id（合成/查询鉴权）。 */
  providerId?: string;
  trainStatus?: VoiceCloneTrainStatus;
  /** 训练失败原因（trainStatus = 'failed' 时）。 */
  trainError?: string;
  /** 火山：该槽位剩余训练次数（状态查询回填）。 */
  volcTrainingTimesLeft?: number;
  /** 试听样本 wav（创建完成后自动合成）。 */
  sampleWavPath?: string;
  /** 创建期质检快照。 */
  quality?: VoiceQualityReport;
  /** 原始来源文件（展示用）。 */
  sourceFile?: string;
  createdAt: number;
}

// ── 质检报告 ────────────────────────────────────────────────────────────────

export type VoiceQualityVerdict = 'good' | 'fair' | 'poor';

/**
 * 质检问题码（i18n 文案键与修复建议由 UI 层按码映射）：
 * error = 阻止创建；warning = 黄牌放行；info = 已自动处理的提示。
 */
export type VoiceQualityIssueCode =
  | 'no-speech' // 未检测到语音
  | 'too-short' // 有效语音 < 硬下限（两引擎都不可用）
  | 'short-for-engine' // 低于所选引擎推荐下限
  | 'low-snr' // 噪音大 / 声音不清晰
  | 'clipping' // 削波（录制过载）
  | 'low-volume' // 音量过低（prepare 自动增益）
  | 'low-speech-ratio' // 语音占比低（自动裁剪兜底后仍低）
  | 'long-silence'; // 含长静音（prepare 自动压缩）

export interface VoiceQualityIssue {
  code: VoiceQualityIssueCode;
  severity: 'error' | 'warning' | 'info';
  /** 数值上下文（UI 拼文案）：时长 ms / SNR dB / 占比等，按 code 语义。 */
  value?: number;
}

/** 选区质检报告（analyze 输出；prepare 后按最终产物复测一次存档）。 */
export interface VoiceQualityReport {
  /** 选区总时长。 */
  durationMs: number;
  /** 有效语音时长（VAD 段并集）。 */
  speechMs: number;
  /** speechMs / durationMs。 */
  speechRatio: number;
  /** 选区内最长静音（ms）。 */
  longestSilenceMs: number;
  /** 语音帧平均电平（dBFS）。 */
  rmsDb: number;
  /** 峰值电平（dBFS）。 */
  peakDb: number;
  /** 近满幅样本占比（0..1）。 */
  clippingRatio: number;
  /** 语音帧与非语音帧能量差的 SNR 估算（dB；无噪声帧时取上限值）。 */
  snrDb: number;
  verdict: VoiceQualityVerdict;
  issues: VoiceQualityIssue[];
}

/** 自动选段建议（毫秒，相对源媒体）。 */
export interface CloneSegmentSuggestion {
  startMs: number;
  endMs: number;
  /** 窗口得分（调试/排序用，UI 不展示）。 */
  score: number;
}

// ── 引擎参数 ────────────────────────────────────────────────────────────────

export interface CloneTargetRange {
  /** 硬下限（有效语音 ms）：低于此值阻止创建。 */
  minSpeechMs: number;
  /** 推荐下限：低于此值黄牌提示效果打折。 */
  idealMinMs: number;
  /** 推荐上限（自动选段的目标窗口）。 */
  idealMaxMs: number;
  /** 硬上限：超出自动截取（火山服务端 >30s 也会自行截断）。 */
  maxMs: number;
}

/**
 * 参考音频时长区间（按引擎）：
 * - zipvoice：官方建议短参考（过长拖慢推理且劣化质量）；另有硬约束——
 *   flow-matching 内存随（参考+目标）序列平方级增长，Electron 进程内
 *   12.5s 参考实测峰值 ~1.5GB、触 PartitionAlloc 单块上限 SIGTRAP，
 *   故上限收紧到 10s（8s 甜点）；
 * - 火山复刻 2.0：官方最佳实践 10–30s，过短（<10s）效果打折。
 */
export const CLONE_TARGET_RANGES: Record<VoiceCloneEngine, CloneTargetRange> = {
  zipvoice: {
    minSpeechMs: 3000,
    idealMinMs: 5000,
    idealMaxMs: 8000,
    maxMs: 10000,
  },
  volcengine: {
    minSpeechMs: 5000,
    idealMinMs: 10000,
    idealMaxMs: 25000,
    maxMs: 30000,
  },
};

/**
 * 文本主导语言粗判（CJK 字符占比）：向导语言自动回填 / 音色语言落库用。
 */
export function dominantTextLanguage(text: string): 'zh' | 'en' {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk += 1;
    } else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      latin += 1;
    }
  }
  // 中文信息密度高（1 字 ≈ 1 词），少量 CJK 即主导。
  return cjk * 3 >= latin ? (cjk > 0 ? 'zh' : 'en') : 'en';
}

/** CJK 字符计数（克隆合成的语速反馈用）。 */
export function cjkCharCount(text: string): number {
  let n = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      n += 1;
    }
  }
  return n;
}

/**
 * 克隆合成的中文语速反馈阈值（跨语言压缩矫正）：
 * ZipVoice 按参考音频先验预测目标时长，参考/文本语言错配（英文参考 +
 * 中文文本）时预测严重不足——实测 43 字中文被压到 3.7s（11.6 字/秒，
 * 不可辨）；同文本中文参考 8.8s（4.9 字/秒）。固定 speed 补偿不可行
 * （实测补偿量随参考时长漂移），改为闭环：原速合成 → 实测字符速率
 * 超 MAX 判「压缩」→ 以 TARGET/实测 作矫正 speed 重合成一次
 * （矫正后时长 ≈ 字数/TARGET，与参考无关）。自然中文 3.5–5.5 字/秒。
 */
export const CLONE_ZH_RATE_MAX_CPS = 6.5;
export const CLONE_ZH_RATE_TARGET_CPS = 4.5;
/** 矫正 speed 下限（超压缩场景 4.5/11.6≈0.39；防极端值失真）。 */
export const CLONE_CORRECTIVE_SPEED_MIN = 0.35;

// ── 按字幕行选段（向导 Step2，来源含字幕时）─────────────────────────────────

export interface SubtitleCueLite {
  startMs: number;
  endMs: number;
  text: string;
}

/** 行间隙超过该值视为语境断开，不再吸收。 */
export const CUE_ABSORB_MAX_GAP_MS = 2000;

/**
 * 以点选字幕行为起点向后吸收相邻行成选区：行间隙 ≤ maxGapMs 才继续、
 * 窗口触引擎硬上限即止、累计行时长达到推荐上限收口（不贪长）。
 * 首尾各留 150ms 余量。点选行本身超上限时按上限截断。
 */
export function absorbCuesFrom(
  cues: SubtitleCueLite[],
  index: number,
  target: CloneTargetRange,
  maxGapMs = CUE_ABSORB_MAX_GAP_MS,
): { startMs: number; endMs: number } | null {
  const first = cues[index];
  if (!first) return null;
  const pad = 150;
  const startMs = Math.max(0, first.startMs - pad);
  let endMs = first.endMs;
  let speech = first.endMs - first.startMs;
  for (let i = index + 1; i < cues.length; i += 1) {
    const cue = cues[i];
    const gap = cue.startMs - endMs;
    if (gap > maxGapMs) break;
    const candidateEnd = cue.endMs + pad;
    if (candidateEnd - startMs > target.maxMs) break;
    endMs = cue.endMs;
    speech += cue.endMs - cue.startMs;
    if (speech >= target.idealMaxMs) break;
  }
  return {
    startMs,
    endMs: Math.min(startMs + target.maxMs, endMs + pad),
  };
}

/** 工作台 voiceId 的克隆音色前缀（`clone:<ClonedVoice.id>`）。 */
export const CLONE_VOICE_PREFIX = 'clone:';

export function isCloneVoiceId(voiceId: string | undefined): boolean {
  return !!voiceId && voiceId.startsWith(CLONE_VOICE_PREFIX);
}

export function cloneIdFromVoiceId(voiceId: string): string {
  return voiceId.slice(CLONE_VOICE_PREFIX.length);
}

export function voiceIdOfClone(cloneId: string): string {
  return `${CLONE_VOICE_PREFIX}${cloneId}`;
}

// ── 音色导入导出（.svoice 单文件包）─────────────────────────────────────────

export const SVOICE_FORMAT = 'smartsub-voice';
export const SVOICE_VERSION = 1;
export const SVOICE_EXT = 'svoice';

/** .svoice 包结构：元信息 + 参考文本/质检快照 + wav 数据（base64）。 */
export interface SvoicePackage {
  format: typeof SVOICE_FORMAT;
  version: number;
  voice: {
    name: string;
    engine: VoiceCloneEngine;
    language: 'zh' | 'en';
    refText?: string;
    /** 火山：同账号跨设备可复用的槽位 id。 */
    speakerId?: string;
    quality?: VoiceQualityReport;
    createdAt: number;
  };
  refWavBase64?: string;
  sampleWavBase64?: string;
}

/** 打包（wav 数据由调用方读盘转 base64 传入）。 */
export function buildSvoicePackage(
  voice: ClonedVoice,
  refWavBase64?: string,
  sampleWavBase64?: string,
): SvoicePackage {
  return {
    format: SVOICE_FORMAT,
    version: SVOICE_VERSION,
    voice: {
      name: voice.name,
      engine: voice.engine,
      language: voice.language,
      refText: voice.refText,
      speakerId: voice.speakerId,
      quality: voice.quality,
      createdAt: voice.createdAt,
    },
    refWavBase64,
    sampleWavBase64,
  };
}

/** 解析校验：结构/版本/引擎必备字段（zipvoice 需参考对；火山需槽位）。 */
export function parseSvoicePackage(
  payload: unknown,
): { ok: true; pkg: SvoicePackage } | { ok: false; error: string } {
  const p = payload as SvoicePackage | null;
  if (!p || typeof p !== 'object' || p.format !== SVOICE_FORMAT) {
    return { ok: false, error: 'format' };
  }
  if (p.version !== SVOICE_VERSION) {
    return { ok: false, error: `version ${p.version}` };
  }
  const v = p.voice;
  if (!v || typeof v.name !== 'string' || !v.name.trim()) {
    return { ok: false, error: 'name' };
  }
  if (v.engine !== 'zipvoice' && v.engine !== 'volcengine') {
    return { ok: false, error: 'engine' };
  }
  if (v.language !== 'zh' && v.language !== 'en') {
    return { ok: false, error: 'language' };
  }
  if (v.engine === 'zipvoice' && (!p.refWavBase64 || !v.refText?.trim())) {
    return { ok: false, error: 'reference' };
  }
  if (v.engine === 'volcengine' && !v.speakerId?.trim()) {
    return { ok: false, error: 'speakerId' };
  }
  return { ok: true, pkg: p };
}

// ── 渲染层视图（voiceClone: IPC 的 data 形状）───────────────────────────────

/** 音色列表/详情视图（main 侧 ClonedVoice 直传，字段已是可序列化纯数据）。 */
export type ClonedVoiceView = ClonedVoice;

/** voiceClone:analyze 返回：整文件分析 + 推荐选段。 */
export interface CloneAnalysisView {
  /** 分析副本 wav（16k mono，media:// 试听与波形渲染用）。 */
  analysisWavPath: string;
  /** 源媒体总时长（ms）。 */
  durationMs: number;
  /** 语音段清单（ms，相对源媒体；波形高亮用）。 */
  speechSegments: Array<{ startMs: number; endMs: number }>;
  /** 推荐选段（无可用语音时为 null）。 */
  suggestion: CloneSegmentSuggestion | null;
  /** 每 100ms 归一化能量包络（0..1，波形条渲染用）。 */
  envelope: number[];
}

/** voiceClone:inspectRange 返回：选区质检报告。 */
export interface CloneRangeReportView {
  report: VoiceQualityReport;
}

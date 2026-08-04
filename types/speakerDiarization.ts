import type { IFormData } from './types';

export const SPEAKER_DIARIZATION_MIN_COUNT = 2;
export const SPEAKER_DIARIZATION_MAX_COUNT = 8;
export const SPEAKER_DIARIZATION_METADATA_SAVE_FAILED =
  'SPEAKER_DIARIZATION_METADATA_SAVE_FAILED';

/** 推理已有结果时，sidecar 是 metadata 模式的持久化边界，失败必须显式告警。 */
export function getSpeakerDiarizationMetadataWarning(
  hasSegments: boolean,
  persisted: boolean,
): typeof SPEAKER_DIARIZATION_METADATA_SAVE_FAILED | undefined {
  return hasSegments && !persisted
    ? SPEAKER_DIARIZATION_METADATA_SAVE_FAILED
    : undefined;
}

const SPEAKER_DIARIZATION_CONFIG_KEYS = [
  'speakerDiarization',
  'speakerDiarizationCount',
  'speakerDiarizationEmbedInSubtitle',
] as const;

/** 运行时只接受 UI 暴露的 2–8；其它值统一回落到自动聚类（-1）。 */
export function normalizeSpeakerDiarizationCount(value: unknown): number {
  const count = Number(value);
  return Number.isInteger(count) &&
    count >= SPEAKER_DIARIZATION_MIN_COUNT &&
    count <= SPEAKER_DIARIZATION_MAX_COUNT
    ? count
    : -1;
}

/** 缺省为 false，避免旧快照或新用户在无感知时污染交付字幕。 */
export function shouldEmbedSpeakerLabels(
  config:
    | Pick<IFormData, 'speakerDiarizationEmbedInSubtitle'>
    | null
    | undefined,
): boolean {
  return config?.speakerDiarizationEmbedInSubtitle === true;
}

/** 内封字幕可跳过 ASR，但角色分离仍必须拿到整段媒体音频。 */
export function shouldExtractAudioForEmbeddedSubtitle(
  config:
    | Pick<IFormData, 'speakerDiarization' | 'dub' | 'compose' | 'recipeName'>
    | null
    | undefined,
): boolean {
  return (
    config?.speakerDiarization === true &&
    isSpeakerDiarizationStandardTaskContext(config)
  );
}

/** 合并、拆分等校对操作共用的角色编号归一化。 */
export function mergeSpeakerIds(
  ...groups: Array<readonly number[] | null | undefined>
): number[] {
  return Array.from(
    new Set(
      groups
        .flatMap((group) => group || [])
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ).sort((a, b) => a - b);
}

export interface SpeakerMetadataCueRange {
  startMs: number;
  endMs: number;
  speakerIds?: readonly number[];
}

/**
 * 时间轴被修改后，按旧 sidecar cue 的时间重叠重新收集角色 metadata。
 * 没有任何旧 cue 与新区间重叠时，保留行上已有值，避免纯平移导致信息丢失。
 */
export function realignSpeakerIdsForCue(
  startMs: number,
  endMs: number,
  existingCues: readonly SpeakerMetadataCueRange[],
  fallback?: readonly number[],
): number[] {
  const overlapping = existingCues
    .filter(
      (cue) => Math.max(startMs, cue.startMs) < Math.min(endMs, cue.endMs),
    )
    .map((cue) => cue.speakerIds);
  const aligned = mergeSpeakerIds(...overlapping);
  return aligned.length ? aligned : mergeSpeakerIds(fallback);
}

/**
 * v1 产品边界：角色分离仅用于标准「转写 / 转写+翻译」任务。
 * 向导附加阶段和用户配方暂不接入，避免在配音映射就绪前产生半成品配置。
 */
export function isSpeakerDiarizationStandardTaskContext(
  config: Pick<IFormData, 'dub' | 'compose' | 'recipeName'> | null | undefined,
): boolean {
  return !config?.dub && !config?.compose && !config?.recipeName;
}

/** 保存配方或构造向导 payload 时移除全部角色分离字段。 */
export function stripSpeakerDiarizationConfig<T extends Record<string, any>>(
  config: T,
): T {
  const next = { ...config };
  for (const key of SPEAKER_DIARIZATION_CONFIG_KEYS) {
    delete next[key];
  }
  return next;
}

/** 主进程的防御性门禁：不支持的任务上下文即使携带旧配置也强制关闭。 */
export function enforceSpeakerDiarizationTaskBoundary<
  T extends Record<string, any>,
>(config: T): T {
  return isSpeakerDiarizationStandardTaskContext(config)
    ? config
    : stripSpeakerDiarizationConfig(config);
}

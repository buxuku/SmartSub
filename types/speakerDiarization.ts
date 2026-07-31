import type { IFormData } from './types';

export const SPEAKER_DIARIZATION_MIN_COUNT = 2;
export const SPEAKER_DIARIZATION_MAX_COUNT = 8;

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

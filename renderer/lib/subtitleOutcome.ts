/**
 * 渲染层「字幕效果档位」展示辅助（UI 用）。
 *
 * ⚠️ 权威映射（档位 → 各引擎底层参数 / VAD 灵敏度）在主进程
 *    main/helpers/engines/outcomePresets.ts，渲染层不参与参数派生，只负责：
 *    1) 列出可选档位；2) 判断引擎是否为 sherpa 系（据此隐藏不适用的上下文/抗重复旋钮）；
 *    3) 反推一个友好的「显示默认」档（与主进程 inferDisplayOutcome 保持一致）。
 *    渲染层故意不复制 VAD 数值与参数映射表，避免敏感映射两处漂移。
 */

export type SubtitleOutcome = 'accurate' | 'balanced' | 'clean' | 'custom';

/** 可在选择器中点选的意图档（custom 单独作为「自定义」入口处理）。 */
export const SUBTITLE_OUTCOME_TIERS: Exclude<SubtitleOutcome, 'custom'>[] = [
  'accurate',
  'balanced',
  'clean',
];

const SHERPA_ENGINES = new Set(['funasr', 'qwen', 'fireRedAsr']);

/** sherpa 系：VAD 结构性常开、无上下文/抗重复概念。 */
export function isSherpaEngine(engine?: string): boolean {
  return !!engine && SHERPA_ENGINES.has(engine);
}

/** 该引擎是否支持「上下文长度 / 抗重复」自定义旋钮（sherpa 系不支持，UI 隐藏）。 */
export function outcomeSupportsContextKnobs(engine?: string): boolean {
  return !isSherpaEngine(engine);
}

function readOutcome(value: unknown): SubtitleOutcome | undefined {
  return value === 'accurate' ||
    value === 'balanced' ||
    value === 'clean' ||
    value === 'custom'
    ? value
    : undefined;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && isFinite(value) ? value : fallback;
}

/**
 * 选择器的显示默认：显式选择优先（任务级 > 全局）；否则把任务级 maxContext 叠加到全局之上
 * 反推（全新安装→balanced；自定义→对应档或 custom）。仅用于初始展示，不写回。
 * 与 main/helpers/engines/outcomePresets.ts 的 inferDisplayOutcome 等价。
 */
export function inferDisplayOutcome(
  formData: Record<string, unknown> | undefined,
  settings: Record<string, unknown> | undefined,
): SubtitleOutcome {
  const explicit =
    readOutcome(formData?.subtitleOutcome) ??
    readOutcome(settings?.subtitleOutcome);
  if (explicit) return explicit;
  const useVAD = settings?.useVAD !== false;
  const maxContext = num(
    formData?.maxContext !== undefined
      ? formData?.maxContext
      : settings?.maxContext,
    -1,
  );
  const reduceRepetition = settings?.reduceRepetition === true;
  if (useVAD && maxContext === -1 && !reduceRepetition) return 'balanced';
  if (useVAD && maxContext === 0 && reduceRepetition) return 'clean';
  return 'custom';
}

/**
 * 字幕效果意图档位（outcome presets）。
 *
 * 把 maxContext / useVAD / reduceRepetition 三个互相重叠、还会互相覆盖的机制旋钮，
 * 收敛成「视频类型 / 想要的效果」单选（文字最准 / 均衡 / 最干净最稳 / 自定义），
 * 并按引擎差异化映射到底层识别参数（逐任务运行时派生，不回写全局）。
 * 设计见 openspec/changes/subtitle-outcome-presets。
 *
 * 纯逻辑、零运行时依赖（不 import electron / registry），供各引擎适配器在取 settings
 * 后叠加一层，再走既有的 getVadSettings / buildXxxParams 等；也供 test:engines 单测。
 */
import { getNumericSetting } from './transcribeShared';

export type SubtitleOutcome = 'accurate' | 'balanced' | 'clean' | 'custom';

export const SUBTITLE_OUTCOMES: SubtitleOutcome[] = [
  'accurate',
  'balanced',
  'clean',
  'custom',
];

export const DEFAULT_SUBTITLE_OUTCOME: SubtitleOutcome = 'balanced';

/** VAD 灵敏度三档（与 settings.tsx 的 VAD_PRESETS 对齐：Quiet/Standard/Noisy）。 */
interface VadTuning {
  vadThreshold: number;
  vadMinSpeechDuration: number;
  vadMinSilenceDuration: number;
  vadMaxSpeechDuration: number;
}
const VAD_QUIET: VadTuning = {
  vadThreshold: 0.35,
  vadMinSpeechDuration: 100,
  vadMinSilenceDuration: 100,
  vadMaxSpeechDuration: 0,
};
const VAD_STANDARD: VadTuning = {
  vadThreshold: 0.5,
  vadMinSpeechDuration: 250,
  vadMinSilenceDuration: 100,
  vadMaxSpeechDuration: 0,
};
const VAD_NOISY: VadTuning = {
  vadThreshold: 0.65,
  vadMinSpeechDuration: 400,
  vadMinSilenceDuration: 150,
  vadMaxSpeechDuration: 0,
};

/** sherpa-onnx 系引擎：VAD 结构性常开、无上下文/抗重复概念，档位只映射 VAD 灵敏度。 */
const SHERPA_ENGINES = new Set(['funasr', 'qwen', 'fireRedAsr']);

export function isSherpaEngineId(engine?: string): boolean {
  return !!engine && SHERPA_ENGINES.has(engine);
}

export function isBuiltinEngineId(engine?: string): boolean {
  return (engine ?? 'builtin') === 'builtin';
}

/** maxContext / reduceRepetition 是否适用于该引擎（sherpa 系不适用，UI 据此隐藏）。 */
export function outcomeSupportsContextKnobs(engine?: string): boolean {
  return !isSherpaEngineId(engine);
}

function readOutcome(value: unknown): SubtitleOutcome | undefined {
  return value === 'accurate' ||
    value === 'balanced' ||
    value === 'clean' ||
    value === 'custom'
    ? value
    : undefined;
}

/**
 * 从既有底层设置反推档位（**仅用于 UI 显示默认**，design D7）：
 * 仅把「跨引擎一致」的 balanced / clean 映射到内置档，其余一律 custom。
 * accurate 因其 useVAD 仅对 builtin 为 false（对 faster-whisper 为 true），跨引擎不一致，
 * 故不自动推断为 accurate，避免显示误导。
 *
 * 注意：`maxContext` 历史上是**任务级**（formData），故 UI 调用方应把任务级 maxContext
 * 叠加到全局之上再传入（见 inferDisplayOutcome），否则会漏看任务自定义的上下文档。
 */
export function inferSubtitleOutcome(
  settings: Record<string, unknown> | undefined,
): SubtitleOutcome {
  const useVAD = settings?.useVAD !== false;
  const maxContext = getNumericSetting(settings?.maxContext, -1);
  const reduceRepetition = settings?.reduceRepetition === true;
  if (useVAD && maxContext === -1 && !reduceRepetition) return 'balanced';
  if (useVAD && maxContext === 0 && reduceRepetition) return 'clean';
  return 'custom';
}

/**
 * 取**运行时生效**档位（供引擎 resolver 使用）：仅认显式选择。
 * 档位是**任务级**配置（`formData.subtitleOutcome`，存 userConfig，按「上次使用」记忆）；
 * 不再有全局默认 UI（design D12），`settings.subtitleOutcome` 仅作历史/防御性回退（通常为空）。
 *
 * 关键迁移保证（design D7）：未显式选择档位时一律回落 `custom`——即「应用既有底层旋钮、
 * 不套用任何预设」。这样老用户（无论 builtin 的任务级 maxContext、还是 sherpa 的自定义
 * 全局 VAD 微调）升级后行为**逐字不变**；全新安装因默认旋钮恰等于 balanced，行为也等价。
 * 不在此做反推，避免「只看全局 whisper 旋钮」的反推误判覆盖任务级/引擎特有参数。
 */
export function getSubtitleOutcome(
  formData: Record<string, unknown> | undefined,
  settings: Record<string, unknown> | undefined,
): SubtitleOutcome {
  return (
    readOutcome(formData?.subtitleOutcome) ??
    readOutcome(settings?.subtitleOutcome) ??
    'custom'
  );
}

/**
 * UI 选择器的**显示默认**：显式选择优先；否则按「任务级 maxContext 叠加全局」反推一个
 * 友好的初始档（全新安装→balanced；老用户自定义→对应档或 custom）。仅用于展示，不持久化；
 * 后端仍以 getSubtitleOutcome 的「显式否则 custom」为准，二者对全新/精确匹配用户行为一致。
 */
export function inferDisplayOutcome(
  formData: Record<string, unknown> | undefined,
  settings: Record<string, unknown> | undefined,
): SubtitleOutcome {
  const explicit =
    readOutcome(formData?.subtitleOutcome) ??
    readOutcome(settings?.subtitleOutcome);
  if (explicit) return explicit;
  const effective: Record<string, unknown> = { ...(settings ?? {}) };
  if (formData?.maxContext !== undefined) {
    effective.maxContext = formData.maxContext;
  }
  return inferSubtitleOutcome(effective);
}

/**
 * 把档位按引擎翻译成底层参数，叠加到 settings 上返回**新对象**（不回写全局）。
 * 各引擎适配器在取 settings 后用本函数包一层，再交给既有的
 * getVadSettings / isReduceRepetitionEnabled / buildXxxParams 等消费。
 */
export function resolveEffectiveSettings(
  formData: Record<string, unknown> | undefined,
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(settings ?? {}) };
  const engine = (formData?.transcriptionEngine as string) || 'builtin';
  const outcome = getSubtitleOutcome(formData, settings);

  // 自定义档：底层值各自独立、维持现状。maxContext / useVAD / reduceRepetition 均为
  // 任务级（formData）优先，缺省回落全局（老任务无任务级字段时行为不变）；并入 settings
  // 供各引擎统一从 settings 读取。这样在某个任务里改 VAD/抗重复不会污染其它任务与全局。
  if (outcome === 'custom') {
    const resolved: Record<string, unknown> = {
      ...base,
      maxContext: getNumericSetting(
        formData?.maxContext,
        getNumericSetting(base.maxContext, -1),
      ),
    };
    if (typeof formData?.useVAD === 'boolean') {
      resolved.useVAD = formData.useVAD;
    }
    if (typeof formData?.reduceRepetition === 'boolean') {
      resolved.reduceRepetition = formData.reduceRepetition;
    }
    return resolved;
  }

  // sherpa 系（funasr / qwen / fireRedAsr）：只映射 VAD 灵敏度，不动上下文/抗重复（不适用）。
  if (isSherpaEngineId(engine)) {
    const tuning =
      outcome === 'accurate'
        ? VAD_QUIET
        : outcome === 'clean'
          ? VAD_NOISY
          : VAD_STANDARD;
    return { ...base, ...tuning };
  }

  // whisper 系（builtin / fasterWhisper / localCli）：映射 useVAD / maxContext / reduceRepetition。
  // useVAD：builtin 的「文字最准」关 VAD（分段更细、文本更准）；其它引擎一律开 VAD。
  const builtin = isBuiltinEngineId(engine);
  if (outcome === 'accurate') {
    return {
      ...base,
      useVAD: builtin ? false : true,
      maxContext: -1,
      reduceRepetition: false,
    };
  }
  if (outcome === 'clean') {
    return { ...base, useVAD: true, maxContext: 0, reduceRepetition: true };
  }
  // balanced（默认）
  return { ...base, useVAD: true, maxContext: -1, reduceRepetition: false };
}

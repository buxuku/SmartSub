import type {
  ActivityObserver,
  ActivityUnit,
} from '../../../types/taskActivity';
/**
 * 断句遍编排（遍 A，design D1/D3/D5/D8）：分窗 → LLM 插标 → 校验反馈循环 →
 * 对齐回时间轴 → 物理护栏。**非纯逻辑层**（依赖翻译服务客户端与任务上下文），
 * 不经 index.ts 导出，管线（fileProcessor）直接引用。
 *
 * 降级矩阵（spec: ai-subtitle-segmentation）：
 *  - 单窗校验重试耗尽且内容被改写 / 对齐失败 / 请求失败 → 该窗保留规则断句；
 *  - 配置错误（密钥缺失等）或全部窗口请求失败 → 整阶段降级为规则断句；
 *  - 任何情况下任务不失败；取消经 AbortSignal 在窗口边界/请求内响应。
 *
 * 温度等生成参数沿用服务层默认（openai 服务 0.3 + provider 自定义参数可覆盖），
 * 思考模式控制在服务层按 provider 配置自动生效（ai-thinking-mode-control）。
 */

import {
  composeWordCues,
  getMergeShortCueOptions,
  getSubtitleCueOptions,
  tokensToTriples,
  type TokenTriple,
} from '../subtitleSegmentation';
import { logMessage } from '../storeManager';
import {
  isTaskCancelledError,
  throwIfSignalCancelled,
  waitForTaskDelay,
} from '../taskContext';
import { TRANSLATOR_MAP } from '../../translate/services/translationProvider';
import { resolveBatchConcurrency } from '../../translate/utils/batchConcurrency';
import { isConfigurationError } from '../../translate/utils/error';
import type { Provider } from '../../translate/types';
import {
  limitsFromCueOptions,
  type AlignedCue,
  type RefineTier,
  type RefineWord,
} from './types';
import {
  buildCueWindowText,
  buildWindowText,
  parseBrSegments,
} from './protocol';
import {
  compareValidations,
  validateSegmentation,
  type SegmentationValidation,
} from './validator';
import { alignSegmentsToCues, alignSegmentsToWords } from './alignment';
import { splitCuesIntoWindows, splitWordsIntoWindows } from './windowing';
import { applySegmentationGuards } from './guards';
import {
  buildSegmentationFeedbackPrompt,
  buildSegmentationSystemPrompt,
  buildSegmentationUserPrompt,
} from './prompts';

/** 校验失败的反馈重试轮数上限（不含首轮，spec: ≤2）。 */
const MAX_FEEDBACK_ROUNDS = 2;

/**
 * 单次请求的超时上限（毫秒）。OpenAI SDK 默认每次尝试等 10 分钟并把超时再重发
 * 两次，一个卡住的窗口会被占住 30 分钟（#507 日志里的两个窗口）。健康请求通常
 * 一两分钟内完成；300 秒与 Ollama 的上限一致，给慢速本地模型留足余量。
 */
const REQUEST_TIMEOUT_MS = 300_000;
/**
 * 手里已有可用答案时，重试只是为了把超长段再切好一点，不值得久等：超时取
 * 「此前最慢请求的 2 倍」，但不低于该下限，也不超过 REQUEST_TIMEOUT_MS。
 */
const MIN_IMPROVEMENT_TIMEOUT_MS = 60_000;

/** 一轮请求的产物：模型原文与校验结果（对齐用的分段在 validation.alignSegments）。 */
interface SegmentationAttempt {
  response: string;
  validation: SegmentationValidation;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AiSegmentationParams {
  onActivity?: ActivityObserver;
  /** 规则断句结果（兜底 + Tier 'segment' 输入）。 */
  cues: TokenTriple[];
  /** 词级序列（sidecar 读出）；null = 近似模式。 */
  words: RefineWord[] | null;
  formData: Record<string, unknown>;
  provider: Provider;
  signal?: AbortSignal;
  onProgress?: (completedWindows: number, totalWindows: number) => void;
}

export interface AiSegmentationOutcome {
  cues: TokenTriple[];
  tier: RefineTier;
  totalWindows: number;
  degradedWindows: number;
  /** 整阶段降级：cues 即原规则断句（原因见日志）。 */
  degraded: boolean;
}

/** RefineWord → TokenTriple，供单窗规则成句兜底。 */
function wordsToTriples(words: RefineWord[]): TokenTriple[] {
  return tokensToTriples(
    words.map((w) => ({
      text: w.text ?? '',
      t0: w.start === null ? Number.NaN : w.start,
      t1: w.end === null ? Number.NaN : w.end,
    })),
  );
}

export async function runAiSegmentation(
  params: AiSegmentationParams,
): Promise<AiSegmentationOutcome> {
  const { cues, words, formData, provider, signal, onProgress, onActivity } =
    params;
  const tier: RefineTier = words && words.length > 0 ? 'word' : 'segment';
  const cueOptions = getSubtitleCueOptions(formData);
  const mergeOptions = getMergeShortCueOptions(formData);
  const limits = limitsFromCueOptions(cueOptions);

  let plannedWindows = 0;
  const fallbackOutcome = (reason: string): AiSegmentationOutcome => {
    logMessage(`AI segmentation degraded to rule cues: ${reason}`, 'warning');
    return {
      cues,
      tier,
      totalWindows: plannedWindows,
      degradedWindows: plannedWindows,
      degraded: true,
    };
  };

  if (cues.length === 0) {
    return { cues, tier, totalWindows: 0, degradedWindows: 0, degraded: false };
  }

  const translator =
    TRANSLATOR_MAP[provider?.type as keyof typeof TRANSLATOR_MAP];
  if (!provider?.isAi || !translator) {
    return fallbackOutcome(
      `provider ${provider?.name ?? '(none)'} is not an AI provider`,
    );
  }

  // 精修专用 provider 覆盖：断句输出是插标纯文本，禁用 JSON/结构化模式。
  const segProvider = {
    ...provider,
    systemPrompt: buildSegmentationSystemPrompt(limits),
    useJsonMode: false,
    structuredOutput: 'disabled' as const,
  };
  const sourceLanguage = String(formData?.sourceLanguage ?? 'auto');
  const targetLanguage = String(formData?.targetLanguage ?? 'auto');

  // 分窗（Tier 'word' 按词、Tier 'segment' 按 cue 边界）。
  const wordWindows = tier === 'word' ? splitWordsIntoWindows(words!) : [];
  const cueRanges =
    tier === 'segment'
      ? splitCuesIntoWindows(cues, {
          preserveGapMs:
            formData.preserveSpeechPauses === true
              ? (cueOptions?.maxGapSeconds ?? 0.5) * 1000
              : Number.POSITIVE_INFINITY,
        })
      : [];
  const totalWindows = tier === 'word' ? wordWindows.length : cueRanges.length;
  plannedWindows = totalWindows;
  if (totalWindows === 0) {
    return { cues, tier, totalWindows: 0, degradedWindows: 0, degraded: false };
  }

  let degradedWindows = 0;
  let requestFailures = 0;
  let completed = 0;
  /** 配置类错误（密钥缺失等）：后续窗口没有重试意义，整阶段降级。 */
  let fatalError: Error | null = null;
  let acceptingActivity = true;
  const active = new Map<number, ActivityUnit>();
  const publish = () => {
    if (!acceptingActivity || signal?.aborted) return;
    onActivity?.({
      phase: 'segmenting',
      completed,
      total: totalWindows,
      unit: 'batches',
      units: [...active.values()],
    });
  };
  const unitState = (
    index: number,
    phase: ActivityUnit['phase'],
    extra: Partial<ActivityUnit> = {},
  ) => {
    const id = index + 1;
    active.set(id, { id, phase, startedAt: Date.now(), ...extra });
    publish();
  };
  publish();

  /** 单窗：LLM 插标 → 校验（≤2 轮反馈）→ 对齐。null = 该窗降级。 */
  const processWindow = async (index: number): Promise<AlignedCue[] | null> => {
    const windowWords = tier === 'word' ? wordWindows[index] : undefined;
    const range = tier === 'segment' ? cueRanges[index] : undefined;
    const text =
      tier === 'word'
        ? buildWindowText(windowWords!)
        : buildCueWindowText(cues, range);
    if (!text.trim()) return [];

    const label = `AI segmentation window ${index + 1}/${totalWindows}`;
    const totalRounds = MAX_FEEDBACK_ROUNDS + 1;
    /**
     * 迄今最好的一次尝试（比较规则见 compareValidations）。重试轮的输出可能比
     * 首轮更差（改坏文本、截断、请求失败），所以保留「最好的」而不是「最后的」，
     * 一次退步不会把已有的可用答案扔掉（#507）。
     */
    let best: SegmentationAttempt | null = null;
    const seenResponses = new Set<string>();
    let rounds = 0;
    let slowestRequestMs = 0;
    let userPrompt = buildSegmentationUserPrompt(text);

    for (let round = 0; round < totalRounds; round += 1) {
      throwIfSignalCancelled(signal);
      // 手里已有可用答案时本轮只是锦上添花：限时更紧，且不做传输层重发（失败
      // 就沿用已有答案）。首轮与抢救受损文本的重试用宽松限时，瞬时错误
      // （429/5xx）仍享有 SDK 的退避重发。
      const improving = best?.validation.contentOk === true;
      const requestLimits = improving
        ? {
            timeoutMs: Math.min(
              REQUEST_TIMEOUT_MS,
              Math.max(MIN_IMPROVEMENT_TIMEOUT_MS, 2 * slowestRequestMs),
            ),
            maxRetries: 0,
          }
        : { timeoutMs: REQUEST_TIMEOUT_MS };
      const requestStartedAt = Date.now();
      unitState(index, round ? 'retrying' : 'requesting', {
        requestStartedAt,
        ...(round
          ? {
              retry: round,
              maxRetries: MAX_FEEDBACK_ROUNDS,
              reason: 'validation' as const,
            }
          : {}),
      });
      let response: string;
      try {
        const responseOrigin = await translator(
          userPrompt,
          segProvider,
          sourceLanguage,
          targetLanguage,
          { signal, ...requestLimits },
        );
        response = Array.isArray(responseOrigin)
          ? responseOrigin.join('\n')
          : String(responseOrigin ?? '');
        slowestRequestMs = Math.max(
          slowestRequestMs,
          Date.now() - requestStartedAt,
        );
      } catch (error) {
        // 重试轮的请求失败（超时 / 网络抖动）且已有可用答案：沿用它，不让一次
        // 失败的重试把整窗扔掉，也不计入「服务不可达」。首轮失败、取消与配置
        // 错误照旧上抛，由调用处按原规则处理。
        const canKeepEarlierAnswer =
          round > 0 &&
          best?.validation.contentOk === true &&
          !signal?.aborted &&
          !isTaskCancelledError(error) &&
          !isConfigurationError(error);
        if (!canKeepEarlierAnswer) throw error;
        logMessage(
          `${label} retry request failed (round ${round + 1}/${totalRounds}), keeping the best earlier answer: ${describeError(error)}`,
          'warning',
        );
        break;
      }
      throwIfSignalCancelled(signal);
      rounds = round + 1;
      unitState(index, 'validating');
      const segments = parseBrSegments(response);
      const validation = validateSegmentation(text, segments, limits);
      if (!best || compareValidations(validation, best.validation) > 0) {
        best = { response, validation };
      }
      if (validation.ok) break;
      logMessage(
        `${label} validation failed (round ${round + 1}/${totalRounds}, contentOk=${validation.contentOk}, similarity ${(validation.similarity * 100).toFixed(1)}%, lengthViolations ${validation.lengthViolations.length})`,
        'warning',
      );
      // 模型把同一个答案原样重复：重试没有改变任何东西（确定性后端），省掉后续请求。
      const fingerprint = response.trim();
      if (seenResponses.has(fingerprint)) {
        logMessage(`${label} repeated an earlier answer, no further retries`);
        break;
      }
      seenResponses.add(fingerprint);
      if (round + 1 < totalRounds) {
        // 反馈基于最好的一次而不是最新一次：最新一次可能是退步的垃圾输出。
        userPrompt = buildSegmentationFeedbackPrompt(
          text,
          best.response,
          best.validation.feedback,
        );
      }
    }

    // 重试耗尽：内容仍被改写 → 降级该窗；仅限长超标（contentOk）→ 接受，
    // 交物理护栏在真实词时间上二次切分（design D8「宽进严出」）。
    if (!best || !best.validation.contentOk) {
      const detail = best?.validation.feedback.split('\n')[0] ?? 'no answer';
      logMessage(
        `${label} degraded to rule cues: content differs from the original after ${rounds} round(s). ${detail}`,
        'warning',
      );
      return null;
    }
    if (best.validation.tolerated) {
      logMessage(
        `${label} copy drifted from the transcript (similarity ${(best.validation.similarity * 100).toFixed(1)}%, within tolerance); breaks were re-anchored to the original text`,
      );
    }
    if (!best.validation.ok) {
      logMessage(
        `${label} accepted with ${best.validation.lengthViolations.length} over-long segment(s) after ${rounds} round(s); the length guard will re-split them`,
      );
    }

    unitState(index, 'aligning');
    // 对齐用校验器给出的分段：严格等值时是模型分段，容差内偏差时是按断点
    // 切开的原文，所以字幕文字始终来自转写本身。
    const alignSegments = best.validation.alignSegments;
    let aligned: AlignedCue[] | null;
    if (tier === 'word') {
      aligned = alignSegmentsToWords(windowWords!, alignSegments);
    } else {
      const alignedCues = alignSegmentsToCues(cues, alignSegments, range);
      aligned = alignedCues ? alignedCues.map((cue) => ({ cue })) : null;
    }
    if (!aligned) {
      logMessage(
        `${label} degraded to rule cues: the answer could not be aligned to the window`,
        'warning',
      );
    }
    return aligned;
  };

  /** 单窗降级兜底：词级按该窗词索引跑规则成句（与成功窗同轴，无 mid-point 混拼）；段级按 cue 切片。 */
  const fallbackForWindow = (index: number): AlignedCue[] => {
    if (tier === 'segment') {
      const [from, to] = cueRanges[index];
      return cues.slice(from, to).map((cue) => ({ cue }));
    }
    const windowWords = wordWindows[index];
    if (!windowWords?.length) return [];
    const ruleCues = composeWordCues(wordsToTriples(windowWords), formData);
    // Already composed from real word times; don't attach the entire window to
    // every fallback cue or the guard can duplicate that window on a later cut.
    return ruleCues.map((cue) => ({ cue }));
  };

  const results: AlignedCue[][] = new Array(totalWindows);
  const concurrency = resolveBatchConcurrency(
    provider.batchConcurrency,
    totalWindows,
  );
  const requestIntervalMs =
    Math.max(0, +(provider.requestInterval || 0)) * 1000;
  // 速率限制：串行化「请求起始时间」，窗口完成后并发照常。
  let nextAllowedStartAt = 0;
  const awaitStartSlot = async (index: number) => {
    if (requestIntervalMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, nextAllowedStartAt - now);
    nextAllowedStartAt = Math.max(now, nextAllowedStartAt) + requestIntervalMs;
    if (wait > 0) {
      unitState(index, 'interval', { waitUntil: now + wait });
      await waitForTaskDelay(wait, signal);
    }
  };

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, totalWindows));
  const startedAt = Date.now();
  logMessage(
    `AI segmentation windows=${totalWindows}, concurrency=${workerCount}, requestInterval=${requestIntervalMs}ms`,
    'info',
  );
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= totalWindows || fatalError) break;
      await awaitStartSlot(index);
      try {
        const aligned = await processWindow(index);
        if (aligned === null) {
          degradedWindows += 1;
          results[index] = fallbackForWindow(index);
        } else {
          results[index] = aligned;
        }
      } catch (error) {
        if (isTaskCancelledError(error)) throw error;
        throwIfSignalCancelled(signal);
        if (isConfigurationError(error)) {
          fatalError =
            error instanceof Error ? error : new Error(String(error));
          break;
        }
        requestFailures += 1;
        degradedWindows += 1;
        results[index] = fallbackForWindow(index);
        logMessage(
          `AI segmentation window ${index + 1}/${totalWindows} request failed, degraded to rule cues: ${describeError(error)}`,
          'warning',
        );
      }
      completed += 1;
      active.delete(index + 1);
      publish();
      if (acceptingActivity && !signal?.aborted)
        onProgress?.(completed, totalWindows);
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    acceptingActivity = false;
  }
  throwIfSignalCancelled(signal);

  if (fatalError) {
    return fallbackOutcome(
      `configuration error: ${(fatalError as Error).message}`,
    );
  }
  if (requestFailures >= totalWindows) {
    return fallbackOutcome('all windows failed (service unreachable?)');
  }

  onActivity?.({ phase: 'aligning', units: [] });
  const aligned = results.flat().filter(Boolean);
  const guarded = applySegmentationGuards(aligned, {
    cueOptions,
    mergeOptions,
    preserveSpeechPauses: formData.preserveSpeechPauses === true,
  });
  const approxNote = tier === 'segment' ? ', timeline=approximate/近似' : '';
  logMessage(
    `AI segmentation done: tier=${tier}${approxNote}, windows=${totalWindows}, concurrency=${workerCount}, elapsed=${Date.now() - startedAt}ms, degradedWindows=${degradedWindows}, cues ${cues.length} -> ${guarded.length}`,
    'info',
  );
  return {
    cues: guarded,
    tier,
    totalWindows,
    degradedWindows,
    degraded: false,
  };
}

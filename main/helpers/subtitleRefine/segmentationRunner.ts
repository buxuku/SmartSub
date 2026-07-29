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
import { validateSegmentation } from './validator';
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

export interface AiSegmentationParams {
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
  const { cues, words, formData, provider, signal, onProgress } = params;
  const tier: RefineTier = words && words.length > 0 ? 'word' : 'segment';
  const cueOptions = getSubtitleCueOptions(formData);
  const mergeOptions = getMergeShortCueOptions(formData);
  const limits = limitsFromCueOptions(cueOptions);

  const fallbackOutcome = (reason: string): AiSegmentationOutcome => {
    logMessage(`AI segmentation degraded to rule cues: ${reason}`, 'warning');
    return {
      cues,
      tier,
      totalWindows: 0,
      degradedWindows: 0,
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
  const cueRanges = tier === 'segment' ? splitCuesIntoWindows(cues) : [];
  const totalWindows = tier === 'word' ? wordWindows.length : cueRanges.length;
  if (totalWindows === 0) {
    return { cues, tier, totalWindows: 0, degradedWindows: 0, degraded: false };
  }

  let degradedWindows = 0;
  let requestFailures = 0;
  let completed = 0;
  /** 配置类错误（密钥缺失等）：后续窗口没有重试意义，整阶段降级。 */
  let fatalError: Error | null = null;

  /** 单窗：LLM 插标 → 校验（≤2 轮反馈）→ 对齐。null = 该窗降级。 */
  const processWindow = async (index: number): Promise<AlignedCue[] | null> => {
    const windowWords = tier === 'word' ? wordWindows[index] : undefined;
    const range = tier === 'segment' ? cueRanges[index] : undefined;
    const text =
      tier === 'word'
        ? buildWindowText(windowWords!)
        : buildCueWindowText(cues, range);
    if (!text.trim()) return [];

    let lastResponse = '';
    let lastSegments: string[] = [];
    let lastValidation: ReturnType<typeof validateSegmentation> | null = null;
    let userPrompt = buildSegmentationUserPrompt(text);

    for (let round = 0; round <= MAX_FEEDBACK_ROUNDS; round += 1) {
      throwIfSignalCancelled(signal);
      const responseOrigin = await translator(
        userPrompt,
        segProvider,
        sourceLanguage,
        targetLanguage,
        { signal },
      );
      throwIfSignalCancelled(signal);
      lastResponse = Array.isArray(responseOrigin)
        ? responseOrigin.join('\n')
        : String(responseOrigin ?? '');
      lastSegments = parseBrSegments(lastResponse);
      lastValidation = validateSegmentation(text, lastSegments, limits);
      if (lastValidation.ok) break;
      logMessage(
        `AI segmentation window ${index + 1}/${totalWindows} validation failed (round ${round + 1}/${MAX_FEEDBACK_ROUNDS + 1}, similarity ${(lastValidation.similarity * 100).toFixed(1)}%, lengthViolations ${lastValidation.lengthViolations.length})`,
        'warning',
      );
      if (round < MAX_FEEDBACK_ROUNDS) {
        userPrompt = buildSegmentationFeedbackPrompt(
          text,
          lastResponse,
          lastValidation.feedback,
        );
      }
    }

    // 重试耗尽：内容仍被改写 → 降级该窗；仅限长超标（contentOk）→ 接受，
    // 交物理护栏在真实词时间上二次切分（design D8「宽进严出」）。
    if (!lastValidation || !lastValidation.contentOk) return null;

    if (tier === 'word') {
      return alignSegmentsToWords(windowWords!, lastSegments);
    }
    const alignedCues = alignSegmentsToCues(cues, lastSegments, range);
    return alignedCues ? alignedCues.map((cue) => ({ cue })) : null;
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
    return ruleCues.map((cue) => ({ cue, words: windowWords }));
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
  const awaitStartSlot = async () => {
    if (requestIntervalMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, nextAllowedStartAt - now);
    nextAllowedStartAt = Math.max(now, nextAllowedStartAt) + requestIntervalMs;
    if (wait > 0) await waitForTaskDelay(wait, signal);
  };

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, totalWindows));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= totalWindows || fatalError) break;
      await awaitStartSlot();
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
          `AI segmentation window ${index + 1}/${totalWindows} request failed, degraded to rule cues: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'warning',
        );
      }
      completed += 1;
      onProgress?.(completed, totalWindows);
    }
  });
  await Promise.all(workers);
  throwIfSignalCancelled(signal);

  if (fatalError) {
    return fallbackOutcome(
      `configuration error: ${(fatalError as Error).message}`,
    );
  }
  if (requestFailures >= totalWindows) {
    return fallbackOutcome('all windows failed (service unreachable?)');
  }

  const aligned = results.flat().filter(Boolean);
  const guarded = applySegmentationGuards(aligned, {
    cueOptions,
    mergeOptions,
  });
  const approxNote = tier === 'segment' ? ', timeline=approximate/近似' : '';
  logMessage(
    `AI segmentation done: tier=${tier}${approxNote}, windows=${totalWindows}, degradedWindows=${degradedWindows}, cues ${cues.length} -> ${guarded.length}`,
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

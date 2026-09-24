/**
 * 通读摘要阶段编排。失败降级为 done + error 码，不阻断翻译。
 */
import fs from 'fs';
import { logMessage, store } from './storeManager';
import {
  getTaskContext,
  getTaskSignal,
  isTaskCancelledError,
  throwIfTaskCancelled,
} from './taskContext';
import {
  detectSubtitleFormatFromContent,
  parseSubtitleEntries,
} from './subtitleFormats';
import { supportedLanguage } from './utils';
import { TRANSLATOR_MAP } from '../translate/services/translationProvider';
import { DEFAULT_BATCH_SIZE } from '../translate/constants';
import type { Provider, TranslatorFunction } from '../translate/types';
import { getCustomLanguageName } from '../../types/language';
import {
  FOLLOW_TRANSLATION_PROVIDER,
  SUMMARY_MAX_UNITS,
  isCjkSummaryTarget,
  resolveSummaryPrompt,
} from '../../types/summaryPrompt';
import {
  describeGlossaryContext,
  matchGlossaryEntries,
  selectGlossaryPromptEntries,
} from '../glossary/core';
import {
  getTaskGlossaryResolution,
  logGlossaryConflicts,
  logGlossaryMatches,
} from './glossaryManager';
import {
  buildSummaryGlossaryBlock,
  buildSummaryInput,
  buildSummaryInstructions,
  clearedSummaryFields,
  computeSummaryFingerprint,
  decideSummaryReuse,
  enforceSummaryCap,
  estimateSummaryBatches,
  normalizeReusedSummary,
  settleSummaryText,
  shouldSkipTrivialSummary,
} from './episodeSummaryCore';
import type { IFiles } from '../../types';

export interface SummaryProviderResolution {
  provider: Provider | null;
  source: 'follow' | 'explicit';
  reason?: string;
}

function getLanguageName(code: string): string {
  const normalized = (code || '').toLowerCase();
  if (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized === 'zh-hans'
  ) {
    return '简体中文';
  }
  if (
    normalized === 'zh-hant' ||
    normalized === 'zh-tw' ||
    normalized === 'zh-hk'
  ) {
    return '繁体中文';
  }
  const customName = getCustomLanguageName(
    code,
    store.get('settings')?.customLanguages,
  );
  if (customName) return customName;
  const lang = supportedLanguage.find((item) => item.value === code);
  return lang?.name || code;
}

export function resolveSummaryProvider(
  formData?: Record<string, unknown>,
): SummaryProviderResolution {
  const providers: Provider[] = store.get('translationProviders') || [];
  const setting = String(
    formData?.summaryProvider || FOLLOW_TRANSLATION_PROVIDER,
  );
  if (setting === FOLLOW_TRANSLATION_PROVIDER) {
    const translateId = String(formData?.translateProvider ?? '-1');
    const provider = providers.find((item) => item.id === translateId);
    if (!provider) {
      return {
        provider: null,
        source: 'follow',
        reason: 'provider-unresolved',
      };
    }
    if (!provider.isAi) {
      return { provider: null, source: 'follow', reason: 'provider-not-ai' };
    }
    return { provider, source: 'follow' };
  }
  const provider = providers.find((item) => item.id === setting);
  if (!provider?.isAi) {
    return { provider: null, source: 'explicit', reason: 'provider-not-ai' };
  }
  return { provider, source: 'explicit' };
}

function addOutputTokens(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  if (typeof first !== 'number' && typeof second !== 'number') return undefined;
  return (first ?? 0) + (second ?? 0);
}

/** 超限重试：压到 N 个单位以内，专名保持源文写法，只出摘要。 */
function summaryCompressionPrompt(
  targetLanguage: string,
  maxUnits: number,
): string {
  const unit = isCjkSummaryTarget(targetLanguage) ? '字' : 'words';
  const langName = getLanguageName(targetLanguage);
  return (
    `把给定摘要压缩到 ${maxUnits} ${unit}以内，用${langName}输出。` +
    '人名、地名、建制、称谓保持源文写法。只输出摘要正文。'
  );
}

function summaryRequestConfig(provider: Provider) {
  return {
    ...provider,
    useJsonMode: false,
    structuredOutput: 'disabled' as const,
  };
}

/** 超限后的第二次调用：同一服务商、同一信号，正文是上一轮摘要。 */
function compressSettledSummary(options: {
  translator: TranslatorFunction;
  provider: Provider;
  sourceLanguage: string;
  targetLanguage: string;
  signal: AbortSignal | undefined;
  onRetryTokens: (completionTokens: number | undefined) => void;
}): (summary: string, maxUnits: number) => Promise<string | string[]> {
  const requestConfig = summaryRequestConfig(options.provider);
  return (summary, maxUnits) => {
    throwIfTaskCancelled();
    return options.translator(
      summary,
      {
        ...requestConfig,
        systemPrompt: summaryCompressionPrompt(options.targetLanguage, maxUnits),
      },
      options.sourceLanguage,
      options.targetLanguage,
      {
        signal: options.signal,
        onResponseMeta: (meta) => {
          options.onRetryTokens(meta.completionTokens);
        },
      },
    );
  };
}

function formatSummaryCapLog(
  originalUnits: number,
  retryUnits: number | undefined,
  finalUnits: number,
): string {
  const retry = retryUnits === undefined ? '-' : String(retryUnits);
  return `摘要长度 原=${originalUnits} 重试=${retry} 最终=${finalUnits} (limit=${SUMMARY_MAX_UNITS})`;
}

function applySummaryState(
  file: IFiles,
  patch: Partial<IFiles>,
  event?: { sender: { send: (channel: string, payload: IFiles) => void } },
): void {
  Object.assign(file, patch);
  event?.sender.send('taskFileChange', { ...file });
}

function cuesFromRaw(
  srtFile: string,
  raw: string,
): Array<{ id: string; text: string }> {
  const entries = parseSubtitleEntries(
    raw,
    detectSubtitleFormatFromContent(srtFile, raw),
  );
  return entries.map((entry) => ({
    id: String(entry.id),
    text: (entry.content || []).join('\n'),
  }));
}

type SummaryFingerprintParams = {
  file: IFiles;
  formData: Record<string, unknown>;
  sourceLanguage: string;
  targetLanguage: string;
};

type SummaryFingerprintLoad =
  | { kind: 'missing-srt' }
  | { kind: 'provider-unresolved'; reason: string }
  | {
      kind: 'ready';
      srtFile: string;
      raw: string;
      provider: Provider;
      prompt: string;
      fingerprint: string;
    };

/**
 * 字幕、服务商、提示词和指纹的唯一入口。
 * 正式摘要和续跑快路径都走这里，避免两套判定分叉。
 */
async function loadSummaryFingerprint(
  params: SummaryFingerprintParams,
): Promise<SummaryFingerprintLoad> {
  const srtFile = params.file.srtFile;
  if (!srtFile || !fs.existsSync(srtFile)) {
    return { kind: 'missing-srt' };
  }
  const raw = await fs.promises.readFile(srtFile, 'utf-8');
  const resolved = resolveSummaryProvider(params.formData);
  const provider = resolved.provider;
  if (!provider) {
    return {
      kind: 'provider-unresolved',
      reason: resolved.reason || 'provider-unresolved',
    };
  }
  const settings = store.get('settings');
  const prompt = resolveSummaryPrompt(settings?.summaryPrompt);
  // 指纹覆盖原始字幕、解析后的提示词、服务商和语言；任一变化都重新生成。
  const fingerprint = computeSummaryFingerprint({
    source: raw,
    prompt,
    providerId: provider.id,
    sourceLanguage: params.sourceLanguage,
    targetLanguage: params.targetLanguage,
  });
  return { kind: 'ready', srtFile, raw, provider, prompt, fingerprint };
}

/**
 * 续跑快路径用的摘要指纹。字幕缺失或服务商无法解析时返回 null。
 * 读取失败只记日志，不抛出。
 */
export async function currentSummaryFingerprint(
  params: SummaryFingerprintParams,
): Promise<string | null> {
  try {
    const loaded = await loadSummaryFingerprint(params);
    return loaded.kind === 'ready' ? loaded.fingerprint : null;
  } catch (error) {
    logMessage(
      `episode summary fingerprint unavailable for ${params.file.fileName}: ${
        error instanceof Error ? error.message : error
      }`,
      'warning',
    );
    return null;
  }
}

export async function runEpisodeSummaryStage(params: {
  event?: { sender: { send: (channel: string, payload: IFiles) => void } };
  file: IFiles;
  formData: Record<string, unknown>;
  sourceLanguage: string;
  targetLanguage: string;
}): Promise<void> {
  const { event, file, formData, sourceLanguage, targetLanguage } = params;
  if (formData?.generateSummary !== true) return;

  const activity = getTaskContext()?.activity?.start(
    'summarizeEpisode',
    'preparing',
  );
  let activityStatus: 'done' | 'cancelled' = 'done';
  try {
  try {
    throwIfTaskCancelled();
    const loaded = await loadSummaryFingerprint({
      file,
      formData,
      sourceLanguage,
      targetLanguage,
    });
    if (loaded.kind === 'missing-srt') {
      applySummaryState(
        file,
        {
          ...clearedSummaryFields(),
          summarizeEpisode: 'done',
          summarizeEpisodeError: 'empty',
        },
        event,
      );
      logMessage(
        `episode summary degraded (empty source) for ${file.fileName}`,
        'warning',
      );
      return;
    }
    if (loaded.kind === 'provider-unresolved') {
      applySummaryState(
        file,
        {
          ...clearedSummaryFields(),
          summarizeEpisode: 'done',
          summarizeEpisodeError: loaded.reason,
        },
        event,
      );
      logMessage(
        `episode summary degraded (${loaded.reason}) for ${file.fileName}`,
        'warning',
      );
      return;
    }

    const { srtFile, raw, provider, prompt, fingerprint } = loaded;
    const existing = String(file.episodeSummary || '');
    if (
      decideSummaryReuse({
        existing,
        storedHash: file.summarySourceHash,
        fingerprint,
      }) === 'reuse'
    ) {
      // 复用只截断，不再请求模型。不写 summarySourceHash，沿用已有指纹。
      const normalized = normalizeReusedSummary(existing, targetLanguage);
      applySummaryState(
        file,
        {
          summarizeEpisode: 'done',
          ...(normalized.changed ? { episodeSummary: normalized.text } : {}),
          ...(file.summarizeEpisodeError
            ? {}
            : { summarizeEpisodeError: undefined }),
        },
        event,
      );
      if (normalized.changed) {
        logMessage(
          formatSummaryCapLog(
            normalized.originalUnits,
            undefined,
            normalized.finalUnits,
          ),
          'info',
        );
      }
      logMessage(
        `resume: reuse episode summary for ${file.fileName} (${normalized.text.length} chars)`,
        'info',
      );
      return;
    }

    applySummaryState(
      file,
      {
        ...clearedSummaryFields(),
        summarizeEpisode: 'loading',
        summarizeEpisodeError: undefined,
      },
      event,
    );

    const cues = cuesFromRaw(srtFile, raw);

    const translators: Provider[] = store.get('translationProviders') || [];
    const translateProvider = translators.find(
      (item) => item.id === formData?.translateProvider,
    );
    const translateBatchSize = translateProvider?.isAi
      ? translateProvider.batchSize
      : DEFAULT_BATCH_SIZE.API;

    if (shouldSkipTrivialSummary(cues.length, translateBatchSize)) {
      applySummaryState(
        file,
        {
          ...clearedSummaryFields(),
          summarizeEpisode: 'done',
          summarizeEpisodeError: 'skipped-trivial',
        },
        event,
      );
      const batches = estimateSummaryBatches(cues.length, translateBatchSize);
      logMessage(
        `字幕仅 ${cues.length} 条 / 预计 ${batches} 批，已跳过摘要（省一次调用）: ${file.fileName}`,
        'info',
      );
      return;
    }

    const translator = TRANSLATOR_MAP[
      provider.type as keyof typeof TRANSLATOR_MAP
    ] as unknown as TranslatorFunction | undefined;
    if (!translator) {
      applySummaryState(
        file,
        {
          ...clearedSummaryFields(),
          summarizeEpisode: 'done',
          summarizeEpisodeError: 'call-failed',
        },
        event,
      );
      logMessage(
        `episode summary degraded (no translator ${provider.type}) for ${file.fileName}`,
        'warning',
      );
      return;
    }

    const glossaryIds = formData?.glossaryIds as string[] | undefined;
    const glossaryResolution = getTaskGlossaryResolution(glossaryIds);
    const glossaryContext = describeGlossaryContext('通读摘要', glossaryIds);
    logGlossaryConflicts(glossaryResolution.conflicts, glossaryContext);
    const matches = matchGlossaryEntries(
      glossaryResolution.entries,
      cues.map((cue) => cue.text),
    );
    const selection = selectGlossaryPromptEntries(matches);
    logGlossaryMatches(
      selection.included,
      glossaryContext,
      selection.omittedCount,
    );
    const glossaryBlock = buildSummaryGlossaryBlock(selection.included);
    const sourceName = getLanguageName(sourceLanguage);
    const targetName = getLanguageName(targetLanguage);
    const instructions = buildSummaryInstructions({
      prompt,
      sourceLanguage: sourceName,
      targetLanguage: targetName,
      glossaryBlock,
    });
    const userText = buildSummaryInput(cues);
    const batches = estimateSummaryBatches(cues.length, translateBatchSize);
    logMessage(
      `📖 通读摘要 ${file.fileName}: cues=${cues.length} translateBatches≈${batches} provider=${provider.name} [${glossaryContext}]`,
      'info',
    );

    throwIfTaskCancelled();
    activity?.update({ phase: 'requesting' });
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    const signal = getTaskSignal() || getTaskContext()?.signal;
    const modelRaw = await translator(
      userText,
      { ...summaryRequestConfig(provider), systemPrompt: instructions },
      sourceLanguage,
      targetLanguage,
      {
        signal,
        onResponseMeta: (meta) => {
          usage = {
            input_tokens: undefined,
            output_tokens: meta.completionTokens,
          };
        },
      },
    );

    const settled = settleSummaryText(modelRaw);
    if (settled.ok === false) {
      applySummaryState(
        file,
        {
          ...clearedSummaryFields(),
          summarizeEpisode: 'done',
          summarizeEpisodeError: settled.error,
          summaryUsage: usage,
        },
        event,
      );
      logMessage(
        `episode summary degraded (${settled.error}) for ${file.fileName}`,
        'warning',
      );
      return;
    }

    const firstOutput = usage?.output_tokens;
    const capped = await enforceSummaryCap({
      text: settled.text,
      targetLang: targetLanguage,
      compress: compressSettledSummary({
        translator,
        provider,
        sourceLanguage,
        targetLanguage,
        signal,
        onRetryTokens: (completionTokens) => {
          // 同一次调用若回传多次，后来的覆盖先前的；两次调用再相加。
          usage = {
            input_tokens: undefined,
            output_tokens: addOutputTokens(firstOutput, completionTokens),
          };
        },
      }),
    });

    applySummaryState(
      file,
      {
        summarizeEpisode: 'done',
        summarizeEpisodeError: undefined,
        episodeSummary: capped.text,
        summaryUsage: usage,
        summarySourceHash: fingerprint,
      },
      event,
    );
    if (capped.retryError) {
      logMessage(`摘要压缩失败，已截断第一轮: ${capped.retryError}`, 'warning');
    }
    if (capped.retried || capped.truncated) {
      logMessage(
        formatSummaryCapLog(
          capped.originalUnits,
          capped.retryUnits,
          capped.finalUnits,
        ),
        'info',
      );
    }
    logMessage(
      `✓ 摘要完成 ${file.fileName} chars=${capped.text.length}`,
      'info',
    );
    if (translateProvider?.isAi) {
      const extra = Math.ceil(capped.text.length / 1.5) * batches;
      logMessage(
        `摘要将随 ${batches} 个翻译批次重发，约 ${extra} token`,
        'info',
      );
    }
  } catch (error) {
    if (isTaskCancelledError(error)) {
      activityStatus = 'cancelled';
      applySummaryState(
        file,
        { summarizeEpisode: '', summarizeEpisodeError: undefined },
        event,
      );
      throw error;
    }
    applySummaryState(
      file,
      {
        ...clearedSummaryFields(),
        summarizeEpisode: 'done',
        summarizeEpisodeError: 'call-failed',
      },
      event,
    );
    logMessage(
      `episode summary degraded (call-failed) for ${file.fileName}: ${
        error instanceof Error ? error.message : error
      }`,
      'warning',
    );
  }
  } finally {
    activity?.finish(activityStatus);
  }
}

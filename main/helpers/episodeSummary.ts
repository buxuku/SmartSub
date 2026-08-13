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
import type { Provider, TranslatorFunction } from '../translate/types';
import { getCustomLanguageName } from '../../types/language';
import {
  FOLLOW_TRANSLATION_PROVIDER,
  resolveSummaryPrompt,
} from '../../types/summaryPrompt';
import {
  matchGlossaryEntries,
  selectGlossaryPromptEntries,
} from '../glossary/core';
import { getTaskGlossaryResolution } from './glossaryManager';
import {
  buildSummaryGlossaryBlock,
  buildSummaryInput,
  buildSummaryInstructions,
  estimateSummaryBatches,
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

function applySummaryState(
  file: IFiles,
  patch: Partial<IFiles>,
  event?: { sender: { send: (channel: string, payload: IFiles) => void } },
): void {
  Object.assign(file, patch);
  event?.sender.send('taskFileChange', { ...file });
}

async function readCues(
  srtFile: string,
): Promise<Array<{ id: string; text: string }>> {
  const raw = await fs.promises.readFile(srtFile, 'utf-8');
  const entries = parseSubtitleEntries(
    raw,
    detectSubtitleFormatFromContent(srtFile, raw),
  );
  return entries.map((entry) => ({
    id: String(entry.id),
    text: (entry.content || []).join('\n'),
  }));
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

  const existing = String(file.episodeSummary || '').trim();
  if (existing) {
    applySummaryState(
      file,
      {
        summarizeEpisode: 'done',
        ...(file.summarizeEpisodeError
          ? {}
          : { summarizeEpisodeError: undefined }),
      },
      event,
    );
    logMessage(
      `resume: reuse episode summary for ${file.fileName} (${existing.length} chars)`,
      'info',
    );
    return;
  }

  applySummaryState(
    file,
    { summarizeEpisode: 'loading', summarizeEpisodeError: undefined },
    event,
  );

  try {
    throwIfTaskCancelled();
    const srtFile = file.srtFile;
    if (!srtFile || !fs.existsSync(srtFile)) {
      applySummaryState(
        file,
        { summarizeEpisode: 'done', summarizeEpisodeError: 'empty' },
        event,
      );
      logMessage(
        `episode summary degraded (empty source) for ${file.fileName}`,
        'warning',
      );
      return;
    }

    const cues = await readCues(srtFile);
    const resolved = resolveSummaryProvider(formData);
    const provider = resolved.provider;
    if (!provider) {
      applySummaryState(
        file,
        {
          summarizeEpisode: 'done',
          summarizeEpisodeError: resolved.reason || 'provider-unresolved',
        },
        event,
      );
      logMessage(
        `episode summary degraded (${resolved.reason}) for ${file.fileName}`,
        'warning',
      );
      return;
    }

    if (shouldSkipTrivialSummary(cues.length, provider.batchSize)) {
      applySummaryState(
        file,
        { summarizeEpisode: 'done', summarizeEpisodeError: 'skipped-trivial' },
        event,
      );
      const batches = estimateSummaryBatches(cues.length, provider.batchSize);
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
        { summarizeEpisode: 'done', summarizeEpisodeError: 'call-failed' },
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
    const matches = matchGlossaryEntries(
      glossaryResolution.entries,
      cues.map((cue) => cue.text),
    );
    const selection = selectGlossaryPromptEntries(matches);
    const glossaryBlock = buildSummaryGlossaryBlock(selection.included);
    const settings = store.get('settings');
    const prompt = resolveSummaryPrompt(settings?.summaryPrompt);
    const sourceName = getLanguageName(sourceLanguage);
    const targetName = getLanguageName(targetLanguage);
    const instructions = buildSummaryInstructions({
      prompt,
      sourceLanguage: sourceName,
      targetLanguage: targetName,
      glossaryBlock,
    });
    const userText = buildSummaryInput(cues);
    const batches = estimateSummaryBatches(cues.length, provider.batchSize);
    logMessage(
      `📖 通读摘要 ${file.fileName}: cues=${cues.length} batches≈${batches} provider=${provider.name}`,
      'info',
    );

    throwIfTaskCancelled();
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    const raw = await translator(
      userText,
      {
        ...provider,
        systemPrompt: instructions,
        useJsonMode: false,
      },
      sourceLanguage,
      targetLanguage,
      {
        signal: getTaskSignal() || getTaskContext()?.signal,
        onResponseMeta: (meta) => {
          usage = {
            input_tokens: undefined,
            output_tokens: meta.completionTokens,
          };
        },
      },
    );

    const settled = settleSummaryText(raw);
    if (!settled.ok) {
      applySummaryState(
        file,
        {
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

    applySummaryState(
      file,
      {
        summarizeEpisode: 'done',
        summarizeEpisodeError: undefined,
        episodeSummary: settled.text,
        summaryUsage: usage,
      },
      event,
    );
    logMessage(
      `✓ 摘要完成 ${file.fileName} chars=${settled.text.length}`,
      'info',
    );
    if (provider.isAi) {
      const extra = Math.ceil(settled.text.length / 1.5) * batches;
      logMessage(
        `摘要将随 ${batches} 个批次重发，约 ${extra} token`,
        'info',
      );
    }
  } catch (error) {
    if (isTaskCancelledError(error)) {
      applySummaryState(
        file,
        { summarizeEpisode: '', summarizeEpisodeError: undefined },
        event,
      );
      throw error;
    }
    applySummaryState(
      file,
      { summarizeEpisode: 'done', summarizeEpisodeError: 'call-failed' },
      event,
    );
    logMessage(
      `episode summary degraded (call-failed) for ${file.fileName}: ${
        error instanceof Error ? error.message : error
      }`,
      'warning',
    );
  }
}

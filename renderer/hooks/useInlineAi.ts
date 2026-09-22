import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { isProviderConfigured } from 'lib/providerUtils';
import type { Provider } from '../../main/translate/types';
import type { Subtitle } from './useSubtitles';
import {
  aiPrompt,
  canAcceptSuggestion,
  cueSnapshot,
  cueStructure,
  type AiIntent,
  type InlineAiSuggestion,
} from '../lib/inlineAi';

interface Options {
  projectId?: string;
  documentKey: string;
  getSubtitles: () => Subtitle[];
  updateSubtitles: (cues: Subtitle[]) => void;
  sourceLanguage?: string;
  targetLanguage?: string;
  shouldShowTranslation: boolean;
}

export function useInlineAi(options: Options) {
  const { t } = useTranslation('home');
  const latest = useRef(options);
  latest.current = options;
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [batchSize, setBatchSize] = useState(5);
  const [suggestions, setSuggestions] = useState<
    Map<number, InlineAiSuggestion>
  >(new Map());
  const suggestionRef = useRef(suggestions);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const jobs = useRef(new Map<string, { key: string; batch: boolean }>());
  const mounted = useRef(true);
  const defaultField = options.shouldShowTranslation
    ? 'targetContent'
    : 'sourceContent';
  const [promptField, setPromptField] =
    useState<InlineAiSuggestion['field']>(defaultField);
  const [prompts, setPrompts] = useState<Record<string, string>>({});

  const publish = useCallback((next: Map<number, InlineAiSuggestion>) => {
    suggestionRef.current = next;
    setSuggestions(next);
  }, []);
  const loadProviders = useCallback(async () => {
    try {
      const result = await window.ipc.invoke('getAiTranslationProviders');
      if (!result?.success || !Array.isArray(result.data))
        throw new Error(result?.error || t('aiOptimizeFailed'));
      if (!mounted.current) return;
      setProviders(result.data);
      setProviderId((previous) =>
        result.data.some(
          (p: Provider) => p.id === previous && isProviderConfigured(p),
        )
          ? previous
          : result.data.find(isProviderConfigured)?.id || '',
      );
      setError('');
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    }
  }, [t]);

  const cancel = useCallback(() => {
    for (const id of Array.from(jobs.current.keys())) {
      void window.ipc
        .invoke('cancelProofreadBatch', { batchId: id })
        .catch(() => {});
    }
    jobs.current.clear();
    const next = new Map(suggestionRef.current);
    for (const [index, suggestion] of Array.from(next))
      if (suggestion.status === 'loading') next.delete(index);
    publish(next);
    setRunning(false);
  }, [publish]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const id of Array.from(jobs.current.keys()))
        void window.ipc
          .invoke('cancelProofreadBatch', { batchId: id })
          .catch(() => {});
      jobs.current.clear();
    };
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    cancel();
    publish(new Map());
    setPromptField(defaultField);
    const cached: Record<string, string> = {};
    for (const promptMode of ['translation', 'transcript'] as const) {
      for (const batch of [false, true]) {
        for (const intent of ['polish', 'shorten'] as const) {
          const key = promptKey(promptMode, batch, intent);
          try {
            cached[key] =
              localStorage.getItem(key) || aiPrompt(promptMode, batch, intent);
          } catch {
            cached[key] = aiPrompt(promptMode, batch, intent);
          }
        }
      }
    }
    setPrompts(cached);
  }, [options.documentKey, defaultField, cancel, publish]);

  const settle = useCallback(
    (id: string, index: number, proposed?: string, failure?: string) => {
      const job = jobs.current.get(id);
      const previous = suggestionRef.current.get(index);
      if (
        !mounted.current ||
        !job ||
        job.key !== latest.current.documentKey ||
        previous?.requestId !== id
      )
        return;
      const next = new Map(suggestionRef.current);
      next.set(index, {
        ...previous,
        status: failure || !proposed?.trim() ? 'error' : 'ready',
        proposed,
        error:
          failure ||
          (!proposed?.trim() ? t('inlineAi.emptyResult') : undefined),
      });
      publish(next);
    },
    [publish, t],
  );

  useEffect(
    () =>
      window.ipc.on(
        'batchOptimizeResult',
        (result: {
          batchId: string;
          index: number;
          status: string;
          optimizedTarget: string;
          error?: string;
        }) => {
          settle(
            result.batchId,
            result.index,
            result.optimizedTarget,
            result.status === 'success'
              ? undefined
              : result.error || t('aiOptimizeFailed'),
          );
        },
      ),
    [settle, t],
  );

  useEffect(
    () =>
      window.ipc.on(
        'batchOptimizeProgress',
        (result: { batchId: string; progress: number }) => {
          const job = jobs.current.get(result.batchId);
          if (job?.batch && job.key === latest.current.documentKey)
            setProgress(result.progress);
        },
      ),
    [],
  );

  const run = useCallback(
    async (
      indices: number[],
      intent: AiIntent = 'polish',
      requestedField?: 'sourceContent' | 'targetContent',
    ) => {
      if (
        !providers.some((p) => p.id === providerId && isProviderConfigured(p))
      ) {
        setError(t('noAiProviderConfigured'));
        return;
      }
      const context = latest.current;
      const cues = context.getSubtitles();
      const selected = Array.from(new Set(indices)).filter(
        (index) => !!cues[index],
      );
      if (!selected.length) return;
      const batch = selected.length > 1;
      if (batch && Array.from(jobs.current.values()).some((job) => job.batch))
        return;
      const id = crypto.randomUUID();
      const structure = cueStructure(cues);
      const field =
        requestedField ||
        (context.shouldShowTranslation ? 'targetContent' : 'sourceContent');
      const requestMode =
        field === 'sourceContent' ? 'transcript' : 'translation';
      setPromptField(field);
      const next = new Map(suggestionRef.current);
      for (const index of selected)
        next.set(index, {
          requestId: id,
          index,
          structure,
          snapshot: cueSnapshot(cues[index]),
          original: cues[index][field] || '',
          field,
          status: 'loading',
          intent,
        });
      jobs.current.set(id, { key: context.documentKey, batch });
      publish(next);
      setRunning(true);
      setError('');
      setProgress(0);
      const settings = {
        projectId: context.projectId,
        providerId,
        batchId: id,
        mode: requestMode,
        sourceLanguage: context.sourceLanguage,
        targetLanguage: context.targetLanguage,
        customPrompt:
          prompts[promptKey(requestMode, batch, intent)] ||
          aiPrompt(requestMode, batch, intent),
        intent,
      };
      try {
        const result = batch
          ? await window.ipc.invoke('batchOptimizeSubtitles', {
              ...settings,
              batchSize,
              maxRetries: 2,
              subtitles: selected.map((index) => ({
                ...cues[index],
                index,
                targetContent: cues[index][field] || '',
              })),
            })
          : await window.ipc.invoke('optimizeSubtitle', {
              ...settings,
              sourceText: cues[selected[0]].sourceContent || '',
              targetText:
                field === 'targetContent'
                  ? cues[selected[0]].targetContent || ''
                  : '',
            });
        if (!result?.success)
          throw new Error(result?.error || t('aiOptimizeFailed'));
        if (batch) {
          for (const row of result.data?.results || []) {
            if (suggestionRef.current.get(row.index)?.status === 'loading')
              settle(
                id,
                row.index,
                row.optimizedTarget,
                row.status === 'success'
                  ? undefined
                  : row.error || t('aiOptimizeFailed'),
              );
          }
          for (const index of selected)
            if (suggestionRef.current.get(index)?.status === 'loading')
              settle(id, index, undefined, t('inlineAi.cancelled'));
        } else settle(id, selected[0], result.data);
      } catch (cause) {
        for (const index of selected)
          settle(id, index, undefined, String(cause));
      } finally {
        jobs.current.delete(id);
        if (mounted.current) setRunning(jobs.current.size > 0);
      }
    },
    [providers, providerId, batchSize, prompts, publish, settle, t],
  );

  const propose = useCallback(
    (index: number, text: string, field: 'sourceContent' | 'targetContent') => {
      const cues = latest.current.getSubtitles();
      if (!cues[index]) return;
      const next = new Map(suggestionRef.current);
      next.set(index, {
        requestId: crypto.randomUUID(),
        index,
        snapshot: cueSnapshot(cues[index]),
        structure: cueStructure(cues),
        original: cues[index][field] || '',
        field,
        intent: 'polish',
        status: 'ready',
        proposed: text,
      });
      publish(next);
    },
    [publish],
  );

  const dismiss = useCallback(
    (index: number) => {
      const next = new Map(suggestionRef.current);
      next.delete(index);
      publish(next);
    },
    [publish],
  );
  const accept = useCallback(
    (index: number) => {
      const suggestion = suggestionRef.current.get(index);
      const cues = latest.current.getSubtitles();
      if (!suggestion || !canAcceptSuggestion(suggestion, cues)) return false;
      latest.current.updateSubtitles(
        cues.map((cue, i) =>
          i === index
            ? {
                ...cue,
                [suggestion.field]: suggestion.proposed,
                ...(suggestion.field === 'sourceContent'
                  ? { content: suggestion.proposed!.split('\n') }
                  : {
                      translationStatus: 'success' as const,
                      translationError: undefined,
                    }),
              }
            : cue,
        ),
      );
      dismiss(index);
      return true;
    },
    [dismiss],
  );
  const changePrompt = (
    batch: boolean,
    intent: AiIntent,
    value: string,
    field: InlineAiSuggestion['field'] = defaultField,
  ) => {
    const key = promptKey(
      field === 'sourceContent' ? 'transcript' : 'translation',
      batch,
      intent,
    );
    setPrompts((previous) => ({ ...previous, [key]: value }));
    try {
      localStorage.setItem(key, value);
    } catch {
      setError(t('inlineAi.settingsFailed'));
    }
  };
  return {
    providers,
    providerId,
    setProviderId,
    batchSize,
    setBatchSize,
    suggestions,
    error,
    running,
    progress,
    run,
    propose,
    cancel,
    accept,
    dismiss,
    loadProviders,
    changePrompt,
    defaultField,
    promptField,
    setPromptField,
    getPrompt: (
      batch: boolean,
      intent: AiIntent,
      field: InlineAiSuggestion['field'] = defaultField,
    ) => {
      const promptMode =
        field === 'sourceContent' ? 'transcript' : 'translation';
      return (
        prompts[promptKey(promptMode, batch, intent)] ||
        aiPrompt(promptMode, batch, intent)
      );
    },
    resetPrompt: (
      batch: boolean,
      intent: AiIntent,
      field: InlineAiSuggestion['field'] = defaultField,
    ) =>
      changePrompt(
        batch,
        intent,
        aiPrompt(
          field === 'sourceContent' ? 'transcript' : 'translation',
          batch,
          intent,
        ),
        field,
      ),
  };
}

function promptKey(
  mode: 'translation' | 'transcript',
  batch: boolean,
  intent: AiIntent,
) {
  const base = batch
    ? mode === 'transcript'
      ? 'ai_batch_proofread_prompt'
      : 'ai_batch_optimize_prompt'
    : mode === 'transcript'
      ? 'ai_proofread_custom_prompt'
      : 'ai_optimize_custom_prompt';
  return intent === 'shorten' ? `${base}_shorten` : base;
}

export type InlineAiControl = ReturnType<typeof useInlineAi>;

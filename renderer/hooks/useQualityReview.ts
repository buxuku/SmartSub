import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QualityInput } from '../lib/qualityChecks';
import {
  checkQuality,
  createQualityCheckCache,
  mergeQualityCatalog,
} from '../lib/qualityChecks';
import {
  qualityStatus,
  type QualityIssue,
  type QualityReviewState,
  type QualityDecision,
  type QualityInsertionDraft,
} from '../../types/qualityReview';
import { resolveEnabledGlossaryEntries } from '../../main/glossary/core';
import type { ResolvedGlossaryEntry } from '../../types/glossary';

export function useQualityReview(
  input: Omit<QualityInput, 'terms'> & {
    documentKey: string;
    enabled: boolean;
    projectId?: string;
    state: QualityReviewState;
    update: (
      next: QualityReviewState,
      record?: boolean,
      dirty?: boolean,
    ) => void;
  },
) {
  const latest = useRef(input);
  latest.current = input;
  const [issues, setIssues] = useState<QualityIssue[]>([]);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState('');
  const [glossaryError, setGlossaryError] = useState('');
  const [terms, setTerms] = useState<ResolvedGlossaryEntry[]>([]);
  const [termsReady, setTermsReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const checkCache = useRef(createQualityCheckCache());
  const refreshTerms = useCallback(async () => {
    const key = latest.current.documentKey;
    const gen = ++generation.current;
    try {
      const result = await window.ipc.invoke('glossaries:list');
      if (key !== latest.current.documentKey || gen !== generation.current)
        return;
      if (!Array.isArray(result)) throw new Error('GLOSSARY_READ_FAILED');
      const resolved = resolveEnabledGlossaryEntries(
        result,
        latest.current.projectId,
      ).entries;
      setTerms((previous) =>
        JSON.stringify(previous) === JSON.stringify(resolved)
          ? previous
          : resolved,
      );
      setGlossaryError('');
    } catch (cause) {
      if (gen === generation.current) {
        setGlossaryError(String(cause));
      }
    } finally {
      if (key === latest.current.documentKey && gen === generation.current)
        setTermsReady(true);
    }
  }, []);
  useEffect(() => {
    setIssues([]);
    setChecked(false);
    setTerms([]);
    setTermsReady(false);
    setError('');
    setGlossaryError('');
    setChecking(input.enabled);
    if (!input.enabled) return;
    void refreshTerms();
    const refresh = () => void refreshTerms();
    window.addEventListener('focus', refresh);
    window.addEventListener('smartsub:glossary-changed', refresh);
    return () => {
      generation.current++;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('smartsub:glossary-changed', refresh);
    };
  }, [input.documentKey, input.projectId, input.enabled, refreshTerms]);

  useEffect(() => {
    if (!input.enabled || !termsReady) return;
    const abort = new AbortController();
    setChecking(true);
    const timer = setTimeout(() => {
      void checkQuality({ ...input, terms }, abort.signal, checkCache.current)
        .then((result) => {
          if (abort.signal.aborted) return;
          setIssues(result);
          setChecked(true);
          setError('');
          setChecking(false);
          const context = latest.current;
          const catalog = mergeQualityCatalog(
            context.state.catalog,
            result,
            context.state.view.active,
          );
          if (catalog !== context.state.catalog)
            context.update({ ...context.state, catalog }, false, false);
        })
        .catch((cause) => {
          if (!abort.signal.aborted) {
            setError(String(cause));
            setChecking(false);
          }
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [
    input.documentKey,
    input.enabled,
    input.subtitles,
    input.warnings,
    input.translation,
    input.sourceLanguage,
    input.targetLanguage,
    input.duration,
    terms,
    termsReady,
    revision,
  ]);

  const current = useMemo(
    () =>
      new Map(
        [
          ...(glossaryError || !checked
            ? input.state.catalog.filter((i) =>
                checked && glossaryError ? i.kind === 'glossary' : true,
              )
            : []),
          ...issues,
        ].map((i) => [i.key, i]),
      ),
    [issues, glossaryError, checked, input.state.catalog],
  );
  const catalog = useMemo(
    () =>
      mergeQualityCatalog(input.state.catalog, issues, input.state.view.active),
    [input.state.catalog, issues, input.state.view.active],
  );
  const status = useCallback(
    (i: QualityIssue) => qualityStatus(i, current, input.state),
    [current, input.state],
  );
  const decide = useCallback(
    (issue: QualityIssue, decision?: QualityDecision) => {
      const context = latest.current;
      const decisions = { ...context.state.decisions };
      if (decision)
        decisions[issue.key] = { evidence: issue.evidence, status: decision };
      else delete decisions[issue.key];
      context.update({ ...context.state, decisions }, true);
    },
    [],
  );
  const view = useCallback((patch: Partial<QualityReviewState['view']>) => {
    const context = latest.current;
    context.update(
      { ...context.state, view: { ...context.state.view, ...patch } },
      false,
      false,
    );
  }, []);
  const editInsertion = useCallback(
    (key: string, draft?: QualityInsertionDraft) => {
      const context = latest.current;
      const insertionDrafts = { ...context.state.insertionDrafts };
      if (draft) insertionDrafts[key] = draft;
      else delete insertionDrafts[key];
      context.update({ ...context.state, insertionDrafts });
    },
    [],
  );
  const counts = useMemo(() => {
    const result = { pending: 0, fixed: 0, confirmed: 0, skipped: 0 };
    for (const i of catalog)
      if (!i.more || input.state.view.more) result[status(i)]++;
    return result;
  }, [catalog, status, input.state.view.more]);
  return {
    issues,
    current,
    catalog,
    checking,
    error,
    glossaryError,
    terms,
    status,
    decide,
    view,
    editInsertion,
    counts,
    retry: () => {
      setRevision((v) => v + 1);
      void refreshTerms();
    },
  };
}
export type QualityControl = ReturnType<typeof useQualityReview>;

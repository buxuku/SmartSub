/**
 * 失败字幕批量重翻：调用主进程 retranslateSubtitles（与正式任务同翻译链路），
 * 支持进度展示与取消；完成/取消后按 id+时间戳一次性回填（一条撤销命令）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import { Subtitle } from './useSubtitles';

export interface RetranslateControl {
  running: boolean;
  cancelling: boolean;
  done: number;
  total: number;
  start: () => void;
  cancel: () => void;
}

interface UseRetranslateFailedOptions {
  documentKey?: string;
  projectId?: string;
  /** 读取最新字幕数组（避免异步结束后拿过期快照） */
  getSubtitles: () => Subtitle[];
  getFailedTranslationIndices: () => number[];
  /** 一次性应用回填（内部产生一条撤销命令） */
  updateSubtitles: (subtitles: Subtitle[]) => void;
  sourceLanguage?: string;
  targetLanguage?: string;
}

export function useRetranslateFailed({
  documentKey,
  projectId,
  getSubtitles,
  getFailedTranslationIndices,
  updateSubtitles,
  sourceLanguage,
  targetLanguage,
}: UseRetranslateFailedOptions): RetranslateControl {
  const { t } = useTranslation('home');
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const batchIdRef = useRef<string | null>(null);
  const contextKey = JSON.stringify([
    documentKey,
    projectId,
    sourceLanguage,
    targetLanguage,
  ]);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;

  useEffect(() => {
    setRunning(false);
    setCancelling(false);
    setDone(0);
    setTotal(0);
    return () => {
      const batchId = batchIdRef.current;
      batchIdRef.current = null;
      if (batchId)
        void window.ipc
          .invoke('cancelProofreadBatch', { batchId })
          .catch(() => {});
    };
  }, [contextKey]);

  // 最新依赖引用，保持 start/cancel 引用稳定
  const latestRef = useRef({
    projectId,
    getSubtitles,
    getFailedTranslationIndices,
    updateSubtitles,
    sourceLanguage,
    targetLanguage,
  });
  latestRef.current = {
    projectId,
    getSubtitles,
    getFailedTranslationIndices,
    updateSubtitles,
    sourceLanguage,
    targetLanguage,
  };

  // 进度事件（按 batchId 过滤）
  useEffect(() => {
    const cleanup = window.ipc.on(
      'retranslateProgress',
      (data: {
        batchId?: string;
        done?: number;
        total?: number;
        fallback?: { fromName: string; toName: string };
      }) => {
        if (!batchIdRef.current || data?.batchId !== batchIdRef.current) return;
        if (typeof data.done === 'number') setDone(data.done);
        if (typeof data.total === 'number') setTotal(data.total);
        if (data.fallback) {
          toast.info(
            t('retranslateProviderFallback', {
              from: data.fallback.fromName,
              to: data.fallback.toName,
            }),
          );
        }
      },
    );
    return cleanup;
  }, [t]);

  const start = useCallback(async () => {
    if (batchIdRef.current) return;
    const {
      getSubtitles: getSubs,
      getFailedTranslationIndices: getFailed,
      sourceLanguage: from,
      targetLanguage: to,
      projectId: contextProjectId,
    } = latestRef.current;

    const current = getSubs();
    const requestContext = contextRef.current;
    const failedIndices = getFailed();
    if (failedIndices.length === 0) return;

    const payload = failedIndices
      .map((i) => current[i])
      .filter(Boolean)
      .map((row) => ({
        id: row.id,
        startEndTime: row.startEndTime,
        content: (row.sourceContent || '').split('\n'),
      }));

    const batchId = `retranslate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const snapshots = new Map(
      failedIndices.map((index) => [index, JSON.stringify(current[index])]),
    );
    const structure = JSON.stringify(
      current.map((row) => [row.id, row.startEndTime]),
    );
    const isCurrent = () =>
      batchIdRef.current === batchId && contextRef.current === requestContext;
    batchIdRef.current = batchId;
    setRunning(true);
    setCancelling(false);
    setDone(0);
    setTotal(payload.length);

    try {
      const result = await window.ipc.invoke('retranslateSubtitles', {
        projectId: contextProjectId,
        subtitles: payload,
        sourceLanguage: from,
        targetLanguage: to,
        batchId,
      });
      if (!isCurrent()) return;

      if (!result?.success && result?.error === 'NO_DEFAULT_PROVIDER') {
        toast.error(t('retranslateNoProvider'));
        return;
      }

      const results: Array<{
        id: string;
        startEndTime: string;
        targetContent: string;
      }> = result?.data || [];

      if (!result?.success && results.length === 0) {
        toast.error(result?.error || t('retranslateFailed'));
        return;
      }

      // 按 id+时间戳回填；运行期间被用户改动过结构/时间的行自然匹配失败跳过
      const resultMap = new Map<string, string>();
      results.forEach((r) => {
        if (r.targetContent && r.targetContent.trim()) {
          resultMap.set(`${r.id}|${r.startEndTime}`, r.targetContent);
        }
      });

      let applied = 0;
      if (resultMap.size > 0) {
        const latest = latestRef.current.getSubtitles();
        if (
          JSON.stringify(latest.map((row) => [row.id, row.startEndTime])) !==
          structure
        )
          return;
        const next = latest.map((row, index) => {
          const hit = resultMap.get(`${row.id}|${row.startEndTime}`);
          // 只回填仍为空的行，避免覆盖用户在重翻期间手动填写的内容
          if (
            hit &&
            snapshots.get(index) === JSON.stringify(row) &&
            (row.translationStatus === 'failed' ||
              !row.targetContent ||
              !row.targetContent.trim() ||
              /^\[翻译失败:/.test(row.targetContent.trim()))
          ) {
            applied += 1;
            return {
              ...row,
              targetContent: hit,
              translationStatus: 'success' as const,
              translationError: undefined,
            };
          }
          return row;
        });
        if (applied > 0) {
          latestRef.current.updateSubtitles(next);
        }
      }

      if (result?.cancelled) {
        toast.info(
          t('retranslateCancelledPartial', { count: applied }) ||
            `已取消，已回填 ${applied} 条`,
        );
      } else if (applied > 0) {
        toast.success(
          t('retranslateDone', { count: applied }) ||
            `重翻完成，已回填 ${applied} 条`,
        );
      } else {
        toast.warning(t('retranslateNoResult'));
      }
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Retranslate error:', error);
      toast.error(t('retranslateFailed'));
    } finally {
      if (isCurrent()) {
        setRunning(false);
        setCancelling(false);
        batchIdRef.current = null;
      }
    }
  }, [t]);

  const cancel = useCallback(async () => {
    if (!batchIdRef.current) return;
    setCancelling(true);
    try {
      await window.ipc.invoke('cancelProofreadBatch', {
        batchId: batchIdRef.current,
      });
    } catch (error) {
      console.error('Cancel retranslate error:', error);
    }
  }, []);

  return { running, cancelling, done, total, start, cancel };
}

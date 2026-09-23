import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
} from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import ProofreadImport from '@/components/proofread/ProofreadImport';
import ProofreadFileList from '@/components/proofread/ProofreadFileList';
import ProofreadEditor from '@/components/proofread/ProofreadEditor';
import { ProofreadTask } from '../../../types/proofread';
import {
  PendingFile,
  loadPendingFileFromItem,
  pendingFileToSaveFormat,
  createPendingFileFromSubtitle,
  createPendingFileFromVideo,
} from '@/lib/proofreadUtils';
import { isSubtitleFile } from 'lib/utils';
import { useConfirmOrUndo } from '../../hooks/useConfirmOrUndo';
import { toast } from 'sonner';
import { useNavigationGuard } from '@/context/NavigationGuardContext';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react';

// 工作流阶段
type WorkflowStage = 'import' | 'list' | 'edit';

// 重新导出 PendingFile 类型供其他组件使用
export type { PendingFile } from '@/lib/proofreadUtils';

export default function ProofreadPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { workItem: workItemQuery, file: fileQuery } = router.query;
  const requestKey = JSON.stringify([workItemQuery || null, fileQuery || null]);
  const request = useMemo(() => {
    if (workItemQuery && fileQuery) return { invalid: true };
    if (workItemQuery)
      return typeof workItemQuery === 'string'
        ? { taskId: workItemQuery }
        : { invalid: true };
    const paths = (Array.isArray(fileQuery) ? fileQuery : [fileQuery]).filter(
      (file): file is string => typeof file === 'string' && Boolean(file),
    );
    return { paths: Array.from(new Set(paths)) };
  }, [requestKey]);
  if (!mounted || !router.isReady) return null;
  // A route target owns its editor, pending reads, saves and undo callbacks.
  return <ProofreadWorkspace key={requestKey} request={request} />;
}

function ProofreadWorkspace({
  request,
}: {
  request: { taskId?: string; paths?: string[]; invalid?: boolean };
}) {
  const router = useRouter();
  const { t } = useTranslation('home');
  const { t: commonT } = useTranslation('common');
  const confirmOrUndo = useConfirmOrUndo();
  const hasRequest = !!(
    request.taskId ||
    request.paths?.length ||
    request.invalid
  );
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    hasRequest ? 'loading' : 'ready',
  );
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const translateRef = useRef(t);
  translateRef.current = t;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);

  // 工作流状态
  const [stage, setStage] = useState<WorkflowStage>('import');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [currentEditIndex, setCurrentEditIndex] = useState<number>(-1);
  const [savedTaskId, setSavedTaskId] = useState<string | null>(null);
  const savedTaskIdRef = useRef(savedTaskId);
  savedTaskIdRef.current = savedTaskId;
  const [taskName, setTaskName] = useState<string>('');
  const [importType, setImportType] = useState<'video' | 'subtitle'>('video');
  const [savedBatch, setSavedBatch] = useState('');
  const savedBatchRef = useRef(savedBatch);
  savedBatchRef.current = savedBatch;
  const batchSnapshot = JSON.stringify({
    taskName,
    items: pendingFiles.map(pendingFileToSaveFormat),
  });
  const batchSnapshotRef = useRef(batchSnapshot);
  batchSnapshotRef.current = batchSnapshot;
  const savingTaskRef = useRef<Promise<boolean> | null>(null);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'save_error'
  >('idle');
  const [saveError, setSaveError] = useState('');
  const isBatchDirty =
    (pendingFiles.length > 0 || Boolean(savedTaskId)) &&
    batchSnapshot !== savedBatch;
  useEffect(() => {
    if (saveStatus !== 'saved') return;
    const timer = setTimeout(() => setSaveStatus('idle'), 3000);
    return () => clearTimeout(timer);
  }, [saveStatus]);

  // 导入完成后进入列表
  const handleImportComplete = useCallback(
    (files: PendingFile[], type: 'video' | 'subtitle') => {
      if (!mounted.current) return;
      epoch.current++;
      savingTaskRef.current = null;
      setPendingFiles(files);
      setSavedTaskId(null);
      setImportType(type);
      // 默认任务名为第一个文件名（去除扩展名）
      const defaultName =
        type === 'video'
          ? files[0]?.fileName?.replace(/\.[^.]+$/, '') || ''
          : files[0]?.fileName || '';
      setTaskName(defaultName);
      setSavedBatch('');
      setSaveStatus('idle');
      setSaveError('');
      setCurrentEditIndex(-1);
      setStage('list');
    },
    [],
  );

  // Publish a complete batch only after all child reads finish for this request.
  useEffect(() => {
    if (!hasRequest) return;
    let cancelled = false;
    const version = ++epoch.current;
    const current = () =>
      !cancelled && mounted.current && version === epoch.current;
    setLoadState('loading');
    setLoadError('');
    (async () => {
      try {
        if (request.invalid)
          throw new Error(
            translateRef.current('proofreadBatchLoad.invalidLink'),
          );
        if (request.taskId) {
          const result = await window.ipc.invoke('getProofreadTaskById', {
            id: request.taskId,
          });
          if (!current()) return;
          if (result?.success !== true)
            throw new Error(result?.error || 'INVALID_PROOFREAD_TASK_RESPONSE');
          if (!result.data)
            throw new Error(
              translateRef.current('proofreadBatchLoad.notFound'),
            );
          const task = result.data as ProofreadTask;
          if (
            task.id !== request.taskId ||
            typeof task.name !== 'string' ||
            !Array.isArray(task.items) ||
            new Set(task.items.map((item) => item?.id)).size !==
              task.items.length
          )
            throw new Error('INVALID_PROOFREAD_TASK_RESPONSE');
          const files = await Promise.all(
            task.items.map((item) =>
              loadPendingFileFromItem(item, { strict: true }),
            ),
          );
          if (!current()) return;
          setImportType(
            task.items.some((item) => item.videoPath) ? 'video' : 'subtitle',
          );
          setPendingFiles(files);
          setSavedTaskId(task.id);
          setTaskName(task.name);
          setSavedBatch(
            JSON.stringify({
              taskName: task.name,
              items: files.map(pendingFileToSaveFormat),
            }),
          );
          setStage('list');
        } else {
          const files = await Promise.all(
            request.paths!.map((file) =>
              isSubtitleFile(file)
                ? createPendingFileFromSubtitle(file, true, { strict: true })
                : createPendingFileFromVideo(file, { strict: true }),
            ),
          );
          if (!current()) return;
          handleImportComplete(
            files,
            request.paths!.every(isSubtitleFile) ? 'subtitle' : 'video',
          );
        }
        setLoadState('ready');
      } catch (error) {
        if (!current()) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoadState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [request, hasRequest, loadAttempt, handleImportComplete]);

  // 开始校对某个文件
  const handleStartProofread = useCallback((index: number) => {
    setCurrentEditIndex(index);
    setPendingFiles((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], status: 'proofreading' };
      return next;
    });
    setStage('edit');
  }, []);

  // 返回列表（不标记完成）
  const handleBackToList = useCallback(() => {
    setCurrentEditIndex(-1);
    setStage('list');
  }, []);

  // 更新文件配置
  const handleUpdateFile = useCallback(
    (index: number, updates: Partial<PendingFile>) => {
      setPendingFiles((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], ...updates };
        return next;
      });
    },
    [],
  );

  // 删除文件（可撤销）
  const handleRemoveFile = useCallback(
    (index: number) => {
      const version = epoch.current;
      let removed: PendingFile | undefined;
      setPendingFiles((prev) => {
        removed = prev[index];
        return prev.filter((_, i) => i !== index);
      });
      confirmOrUndo(t('fileRemoved'), () => {
        if (!removed || !mounted.current || version !== epoch.current) return;
        const item = removed;
        setPendingFiles((prev) => {
          const next = [...prev];
          next.splice(Math.min(index, next.length), 0, item);
          return next;
        });
      });
    },
    [confirmOrUndo, t],
  );

  // 追加文件
  const handleAddFiles = useCallback((newFiles: PendingFile[]) => {
    setPendingFiles((prev) => [...prev, ...newFiles]);
  }, []);

  // 保存任务
  const saveTaskSnapshot = useCallback(
    async (completedFiles?: PendingFile[]): Promise<boolean> => {
      if (!mounted.current || loadState !== 'ready') return false;
      const version = epoch.current;
      const current = () => mounted.current && version === epoch.current;
      // 使用工具函数转换为保存格式
      const items = (completedFiles || pendingFiles).map(
        pendingFileToSaveFormat,
      );
      const savingSnapshot = JSON.stringify({ taskName, items });
      setSaveStatus('saving');
      setSaveError('');

      try {
        const taskId = savedTaskIdRef.current;
        if (taskId) {
          // 更新现有任务
          const result = await window.ipc.invoke('updateProofreadTask', {
            taskId,
            updates: { items, name: taskName },
          });
          if (!current()) return false;
          if (result?.success !== true || result.data?.id !== taskId)
            throw new Error(result?.error || t('saveFailed'));
        } else {
          // 创建新任务
          const result = await window.ipc.invoke('createProofreadTask', {
            items,
            name:
              taskName ||
              pendingFiles[0]?.fileName?.replace(/\.[^.]+$/, '') ||
              'Untitled',
          });
          if (!current()) return false;
          if (result?.success !== true || !result.data?.id)
            throw new Error(result?.error || t('saveFailed'));
          setSavedTaskId(result.data.id);
          savedTaskIdRef.current = result.data.id;
        }
        if (completedFiles) {
          setPendingFiles(completedFiles);
          batchSnapshotRef.current = savingSnapshot;
        }
        savedBatchRef.current = savingSnapshot;
        setSavedBatch(savingSnapshot);
        const unchanged = batchSnapshotRef.current === savingSnapshot;
        setSaveStatus(unchanged ? 'saved' : 'idle');
        return unchanged;
      } catch (error) {
        if (!current()) return false;
        console.error('Error invoking proofread save:', error);
        setSaveStatus('save_error');
        setSaveError(error instanceof Error ? error.message : String(error));
        toast.error(t('saveFailed'));
        return false;
      }
    },
    [pendingFiles, taskName, t, loadState],
  );

  const handleSaveTask = useCallback((): Promise<boolean> => {
    if (savingTaskRef.current) return savingTaskRef.current;
    const promise = saveTaskSnapshot().finally(() => {
      if (savingTaskRef.current === promise) savingTaskRef.current = null;
    });
    savingTaskRef.current = promise;
    return promise;
  }, [saveTaskSnapshot]);

  // Completion includes the batch status write; failed saves keep the editor open.
  const handleMarkComplete = useCallback(async () => {
    if (savingTaskRef.current && !(await savingTaskRef.current)) return;
    const next = pendingFiles.map((file, index) =>
      index === currentEditIndex
        ? { ...file, status: 'completed' as const }
        : file,
    );
    const promise = saveTaskSnapshot(next).finally(() => {
      if (savingTaskRef.current === promise) savingTaskRef.current = null;
    });
    savingTaskRef.current = promise;
    if (!(await promise)) return;
    setCurrentEditIndex(-1);
    setStage('list');
  }, [pendingFiles, currentEditIndex, saveTaskSnapshot]);

  useNavigationGuard('proofread-batch', {
    isDirty: isBatchDirty,
    getIsDirty: () =>
      batchSnapshotRef.current !== savedBatchRef.current &&
      (pendingFiles.length > 0 || Boolean(savedTaskId)),
    onSave: handleSaveTask,
  });

  // 重置，开始新的导入（可撤销）
  const handleReset = useCallback(() => {
    const version = ++epoch.current;
    savingTaskRef.current = null;
    const prev = {
      pendingFiles,
      currentEditIndex,
      savedTaskId,
      taskName,
      importType,
      stage,
      savedBatch,
    };
    setPendingFiles([]);
    setCurrentEditIndex(-1);
    setSavedTaskId(null);
    setTaskName('');
    setSavedBatch('');
    setSaveStatus('idle');
    setSaveError('');
    setImportType('video');
    setStage('import');
    if (prev.pendingFiles.length > 0) {
      confirmOrUndo(t('importReset'), () => {
        if (!mounted.current || epoch.current !== version) return;
        epoch.current++;
        savingTaskRef.current = null;
        setPendingFiles(prev.pendingFiles);
        setCurrentEditIndex(prev.currentEditIndex);
        setSavedTaskId(prev.savedTaskId);
        setTaskName(prev.taskName);
        setImportType(prev.importType);
        setStage(prev.stage);
        setSavedBatch(prev.savedBatch);
      });
    }
  }, [
    pendingFiles,
    currentEditIndex,
    savedTaskId,
    taskName,
    importType,
    stage,
    savedBatch,
    confirmOrUndo,
    t,
  ]);

  // 自动保存：当已保存的任务有变化时自动更新
  const isInitialMount = useRef(true);
  useEffect(() => {
    // 跳过首次加载
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // Empty lists must also persist deletions; failures wait for an edit or manual retry.
    if (savedTaskId && isBatchDirty && stage === 'list') {
      const autoSaveTimeout = setTimeout(async () => {
        try {
          await handleSaveTask();
        } catch (error) {
          console.error('Auto-save failed:', error);
        }
      }, 500); // 防抖 500ms

      return () => clearTimeout(autoSaveTimeout);
    }
  }, [
    pendingFiles,
    savedTaskId,
    stage,
    taskName,
    handleSaveTask,
    isBatchDirty,
  ]);

  // 渲染当前阶段
  const renderStage = () => {
    switch (stage) {
      case 'import':
        // 空态导入：统一三步引导，包在虚线面板里（与任务/配音/合成页同形态）
        return (
          <div className="h-full rounded-lg border-2 border-dashed border-border-strong">
            <ProofreadImport onImportComplete={handleImportComplete} />
          </div>
        );

      case 'list':
        return (
          <ProofreadFileList
            files={pendingFiles}
            savedTaskId={savedTaskId}
            taskName={taskName}
            importType={importType}
            onTaskNameChange={setTaskName}
            onStartProofread={handleStartProofread}
            onUpdateFile={handleUpdateFile}
            onRemoveFile={handleRemoveFile}
            onAddFiles={handleAddFiles}
            onSaveTask={handleSaveTask}
            saveStatus={saveStatus}
            isDirty={isBatchDirty}
            onReset={handleReset}
          />
        );

      case 'edit':
        const currentFile = pendingFiles[currentEditIndex];
        return (
          <ProofreadEditor
            projectId={savedTaskId || undefined}
            ensureProject={async () => {
              const version = epoch.current;
              if (!savedTaskIdRef.current && !(await handleSaveTask()))
                return undefined;
              if (!mounted.current || epoch.current !== version)
                return undefined;
              return savedTaskIdRef.current || undefined;
            }}
            file={currentFile}
            onMarkComplete={handleMarkComplete}
            onBack={handleBackToList}
          />
        );

      default:
        return null;
    }
  };

  return (
    <div className="h-full p-3 overflow-hidden flex flex-col gap-3">
      {loadState !== 'ready' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
          <Button
            variant="ghost"
            className="self-start"
            onClick={() =>
              void router.push(`/${router.query.locale || 'zh'}/proofread/`)
            }
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('proofreadBatchLoad.back')}
          </Button>
          {loadState === 'loading' ? (
            <div
              role="status"
              aria-label={t('proofreadBatchLoad.loading')}
              className="flex flex-1 items-center justify-center"
            >
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : (
            <div
              role="alert"
              className="space-y-3 bg-destructive/10 p-4 text-sm"
            >
              <p>{t('proofreadBatchLoad.failed')}</p>
              <p className="text-muted-foreground">
                {t('proofreadBatchLoad.repair')}
              </p>
              <details>
                <summary>{commonT('saveState.details')}</summary>
                <p className="break-all whitespace-pre-wrap">{loadError}</p>
              </details>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLoadAttempt((value) => value + 1)}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('proofreadLoad.retry')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          {saveError && (
            <div
              role="alert"
              className="flex shrink-0 items-start gap-3 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <details open className="min-w-0 flex-1">
                <summary>{commonT('saveState.save_error')}</summary>
                <p className="break-words whitespace-pre-wrap pt-1 text-xs">
                  {saveError}
                </p>
              </details>
              <Button
                variant="outline"
                size="sm"
                disabled={saveStatus === 'saving'}
                onClick={() => void handleSaveTask()}
              >
                {commonT('saveState.retry')}
              </Button>
            </div>
          )}
          <div className="flex-1 overflow-auto min-h-0">{renderStage()}</div>
        </>
      )}
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'home']);
export { getStaticPaths };

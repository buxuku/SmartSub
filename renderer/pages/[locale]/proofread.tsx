import React, { useState, useCallback, useEffect, useRef } from 'react';
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

// 工作流阶段
type WorkflowStage = 'import' | 'list' | 'edit';

// 重新导出 PendingFile 类型供其他组件使用
export type { PendingFile } from '@/lib/proofreadUtils';

export default function ProofreadPage() {
  const router = useRouter();
  const { workItem: workItemQuery, file: fileQuery } = router.query;
  const { t } = useTranslation('home');
  const { t: commonT } = useTranslation('common');
  const confirmOrUndo = useConfirmOrUndo();

  // 工作流状态
  const [stage, setStage] = useState<WorkflowStage>('import');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [currentEditIndex, setCurrentEditIndex] = useState<number>(-1);
  const [savedTaskId, setSavedTaskId] = useState<string | null>(null);
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

  // 从历史任务加载
  const handleLoadTask = useCallback(async (task: ProofreadTask) => {
    // 使用工具函数为每个项目加载可用字幕
    const files: PendingFile[] = await Promise.all(
      task.items.map((item) => loadPendingFileFromItem(item)),
    );

    // 判断导入类型
    const hasVideo = task.items.some((item) => item.videoPath);
    setImportType(hasVideo ? 'video' : 'subtitle');

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
    setSaveStatus('idle');
    setSaveError('');
  }, []);

  // 从启动台 deep link 加载已保存的校对批次
  useEffect(() => {
    if (typeof workItemQuery !== 'string' || !workItemQuery) return;

    let cancelled = false;
    (async () => {
      try {
        const result = await window.ipc.invoke('getProofreadTaskById', {
          id: workItemQuery,
        });
        if (cancelled || !result?.success || !result.data) return;
        await handleLoadTask(result.data as ProofreadTask);
      } catch (error) {
        console.error('Failed to load proofread work item:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workItemQuery, handleLoadTask]);

  // 导入完成后进入列表
  const handleImportComplete = useCallback(
    (files: PendingFile[], type: 'video' | 'subtitle') => {
      setPendingFiles(files);
      setSavedTaskId(null);
      setImportType(type);
      // 默认任务名为第一个文件名（去除扩展名）
      const defaultName = files[0]?.fileName?.replace(/\.[^.]+$/, '') || '';
      setTaskName(defaultName);
      setStage('list');
    },
    [],
  );

  // 从 URL 参数直接加载待校对文件（如工具箱转换/校准后一键进入：?file=...）
  useEffect(() => {
    const paths = (Array.isArray(fileQuery) ? fileQuery : [fileQuery]).filter(
      (file): file is string => typeof file === 'string' && Boolean(file),
    );
    if (!paths.length) return;

    let cancelled = false;
    (async () => {
      try {
        const pending = (
          await Promise.all(
            Array.from(new Set(paths)).map((file) =>
              isSubtitleFile(file)
                ? createPendingFileFromSubtitle(file)
                : createPendingFileFromVideo(file),
            ),
          )
        ).filter(Boolean);
        if (cancelled || !pending.length) return;
        handleImportComplete(
          pending,
          paths.every(isSubtitleFile) ? 'subtitle' : 'video',
        );
      } catch (error) {
        console.error('Failed to load file from query into proofread:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileQuery, handleImportComplete]);

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

  // 标记完成，返回列表
  const handleMarkComplete = useCallback(() => {
    setPendingFiles((prev) => {
      const next = [...prev];
      next[currentEditIndex] = {
        ...next[currentEditIndex],
        status: 'completed',
      };
      return next;
    });
    setCurrentEditIndex(-1);
    setStage('list');
  }, [currentEditIndex]);

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
      let removed: PendingFile | undefined;
      setPendingFiles((prev) => {
        removed = prev[index];
        return prev.filter((_, i) => i !== index);
      });
      confirmOrUndo(t('fileRemoved'), () => {
        if (!removed) return;
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
  const saveTaskSnapshot = useCallback(async (): Promise<boolean> => {
    // 使用工具函数转换为保存格式
    const items = pendingFiles.map(pendingFileToSaveFormat);
    setSaveStatus('saving');
    setSaveError('');

    try {
      if (savedTaskId) {
        // 更新现有任务
        const result = await window.ipc.invoke('updateProofreadTask', {
          taskId: savedTaskId,
          updates: { items, name: taskName },
        });
        if (result?.success !== true || result.data?.id !== savedTaskId)
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
        if (result?.success !== true || !result.data?.id)
          throw new Error(result?.error || t('saveFailed'));
        setSavedTaskId(result.data.id);
      }
      savedBatchRef.current = batchSnapshot;
      setSavedBatch(batchSnapshot);
      const unchanged = batchSnapshotRef.current === batchSnapshot;
      setSaveStatus(unchanged ? 'saved' : 'idle');
      return unchanged;
    } catch (error) {
      console.error('Error invoking proofread save:', error);
      setSaveStatus('save_error');
      setSaveError(error instanceof Error ? error.message : String(error));
      toast.error(t('saveFailed'));
      return false;
    }
  }, [pendingFiles, savedTaskId, taskName, t, batchSnapshot]);

  const handleSaveTask = useCallback((): Promise<boolean> => {
    if (savingTaskRef.current) return savingTaskRef.current;
    const promise = saveTaskSnapshot().finally(() => {
      savingTaskRef.current = null;
    });
    savingTaskRef.current = promise;
    return promise;
  }, [saveTaskSnapshot]);

  useNavigationGuard('proofread-batch', {
    isDirty: isBatchDirty,
    getIsDirty: () =>
      batchSnapshotRef.current !== savedBatchRef.current &&
      (pendingFiles.length > 0 || Boolean(savedTaskId)),
    onSave: handleSaveTask,
  });

  // 重置，开始新的导入（可撤销）
  const handleReset = useCallback(() => {
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
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'home']);
export { getStaticPaths };

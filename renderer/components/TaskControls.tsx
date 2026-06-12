import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import type { TaskTypeDef } from 'lib/taskTypes';
import { getFileStages, isFileDone } from './tasks/stageUtils';
import { useHotkeys } from 'hooks/useHotkeys';

interface TaskControlsProps {
  files: any[];
  formData: any;
  typeDef: TaskTypeDef;
  projectId: string | null;
  className?: string;
  /** 可选：状态变化时上抛（任务页用于联动重试按钮/完成横幅） */
  onStatusChange?: (status: string) => void;
}

type TaskCompletePayload = { projectId?: string; status?: string } | string;

const TaskControls = ({
  files,
  formData,
  typeDef,
  projectId,
  className,
  onStatusChange,
}: TaskControlsProps) => {
  const [taskStatus, setTaskStatusState] = useState('idle');
  const { t } = useTranslation(['home', 'common']);

  const setTaskStatus = (status: string) => {
    setTaskStatusState(status);
    onStatusChange?.(status);
  };

  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    // 获取当前工程的任务状态
    const getCurrentTaskStatus = async () => {
      const status = await window?.ipc?.invoke('getTaskStatus', projectId);
      if (!disposed && status) setTaskStatus(status);
    };
    getCurrentTaskStatus();

    // 监听本工程的任务完成事件
    const cleanup = window?.ipc?.on(
      'taskComplete',
      (payload: TaskCompletePayload) => {
        const status = typeof payload === 'string' ? payload : payload?.status;
        const pid =
          typeof payload === 'string' ? undefined : payload?.projectId;
        if (pid && pid !== projectId) return;
        if (status) setTaskStatus(status);
      },
    );

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [projectId]);

  const handleTask = async () => {
    if (!files?.length) {
      toast(t('common:notification'), {
        description: t('home:noTask'),
      });
      return;
    }
    // 只派发未完成的文件（error 不算完成，可重跑；已完成文件不重做）
    const pendingFiles = files.filter(
      (file) => !isFileDone(file, getFileStages(file, typeDef, formData)),
    );
    if (!pendingFiles.length) {
      toast(t('common:notification'), {
        description: t('home:allFilesProcessed'),
      });
      return;
    }
    setTaskStatus('running');
    window?.ipc?.send('handleTask', {
      files: pendingFiles,
      formData,
      projectId,
    });
  };
  const handlePause = () => {
    window?.ipc?.send('pauseTask', projectId);
    setTaskStatus('paused');
  };

  const handleResume = () => {
    window?.ipc?.send('resumeTask', projectId);
    setTaskStatus('running');
  };

  const handleCancel = () => {
    window?.ipc?.send('cancelTask', projectId);
    setTaskStatus('cancelling');
  };

  const showStart =
    taskStatus === 'idle' ||
    taskStatus === 'completed' ||
    taskStatus === 'cancelled';

  // Cmd/Ctrl+Enter 等价点击「开始任务」（仅可开始状态下生效）
  useHotkeys([
    {
      combo: 'mod+enter',
      allowInInput: true,
      handler: () => {
        if (showStart && files.length) handleTask();
      },
    },
  ]);

  return (
    <div className={cn('flex items-center gap-2 ml-auto', className)}>
      {taskStatus === 'paused' && (
        <span className="text-xs text-muted-foreground">
          {t('home:pausedHint')}
        </span>
      )}
      {taskStatus === 'cancelling' && (
        <span className="text-xs text-muted-foreground">
          {t('home:cancellingHint')}
        </span>
      )}
      {showStart && (
        <Button onClick={handleTask} disabled={!files.length}>
          {taskStatus === 'cancelled'
            ? t('home:restartTask')
            : t('home:startTask')}
        </Button>
      )}
      {taskStatus === 'running' && (
        <>
          <Button onClick={handlePause} title={t('home:pauseTip')}>
            {t('home:pauseTask')}
          </Button>
          <Button onClick={handleCancel}>{t('home:cancelTask')}</Button>
        </>
      )}
      {taskStatus === 'paused' && (
        <>
          <Button onClick={handleResume}>{t('home:resumeTask')}</Button>
          <Button onClick={handleCancel}>{t('home:cancelTask')}</Button>
        </>
      )}
      {taskStatus === 'cancelling' && (
        <Button disabled>{t('home:cancelling')}</Button>
      )}
    </div>
  );
};

export default TaskControls;

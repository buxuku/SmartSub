import { Dispatch, SetStateAction, useEffect, useMemo, useState } from 'react';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import { RefreshCw } from 'lucide-react';
import { IFiles } from '../../types';
import {
  getFailedTaskFiles,
  getRunnableTaskFiles,
  resetTaskRunState,
} from '@/lib/taskWorkflow';

interface TaskControlsProps {
  files: IFiles[];
  setFiles: Dispatch<SetStateAction<IFiles[]>>;
  formData: any;
  className?: string;
}

const TaskControls = ({
  files,
  setFiles,
  formData,
  className,
}: TaskControlsProps) => {
  const [taskStatus, setTaskStatus] = useState('idle');
  const { t } = useTranslation(['home', 'common']);
  const failedFiles = useMemo(
    () => getFailedTaskFiles(files, formData),
    [files, formData],
  );

  useEffect(() => {
    // 获取当前任务状态
    const getCurrentTaskStatus = async () => {
      const status = await window?.ipc?.invoke('getTaskStatus');
      setTaskStatus(status);
    };
    getCurrentTaskStatus();

    // 监听任务状态变化
    const cleanup = window?.ipc?.on('taskComplete', (status: string) => {
      setTaskStatus(status);
    });

    return () => {
      cleanup?.();
    };
  }, []);

  const startTaskWithFiles = (filesToRun: IFiles[]) => {
    const taskIds = new Set(filesToRun.map((file) => file.uuid));
    const nextFiles = files.map((file) =>
      taskIds.has(file.uuid) ? resetTaskRunState(file) : file,
    );
    const queuedFiles = nextFiles.filter((file) => taskIds.has(file.uuid));

    setFiles(nextFiles);
    setTaskStatus('running');
    window?.ipc?.send('handleTask', { files: queuedFiles, formData });
  };

  const handleTask = () => {
    if (!files?.length) {
      toast(t('common:notification'), {
        description: t('home:noTask'),
      });
      return;
    }

    const runnableFiles = getRunnableTaskFiles(files, formData);
    if (!runnableFiles.length) {
      toast(t('common:notification'), {
        description: t('home:allFilesProcessed'),
      });
      return;
    }
    // if(formData.model && needsCoreML(formData.model)){
    //   const checkMlmodel = await window.ipc.invoke('checkMlmodel', formData.model);
    //   if(!checkMlmodel){
    //     toast(t('common:notification'), {
    //       description: t('home:missingEncoderMlmodelc'),
    //     });
    //     return;
    //   }
    // }
    startTaskWithFiles(runnableFiles);
  };

  const handleRetryFailed = () => {
    if (!failedFiles.length) {
      toast(t('common:notification'), {
        description: t('home:noFailedTasks', {
          defaultValue: '没有失败任务需要重试',
        }),
      });
      return;
    }

    startTaskWithFiles(failedFiles);
  };
  const handlePause = () => {
    window?.ipc?.send('pauseTask', null);
    setTaskStatus('paused');
  };

  const handleResume = () => {
    window?.ipc?.send('resumeTask', null);
    setTaskStatus('running');
  };

  const handleCancel = () => {
    window?.ipc?.send('cancelTask', null);
    setTaskStatus('cancelled');
  };
  return (
    <div className={cn('flex gap-2 ml-auto', className)}>
      {(taskStatus === 'idle' || taskStatus === 'completed') && (
        <>
          {failedFiles.length > 0 && (
            <Button
              variant="outline"
              onClick={handleRetryFailed}
              disabled={!files.length}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('home:retryFailedTasks', {
                count: failedFiles.length,
                defaultValue: `重试失败任务 (${failedFiles.length})`,
              })}
            </Button>
          )}
          <Button onClick={handleTask} disabled={!files.length}>
            {t('home:startTask')}
          </Button>
        </>
      )}
      {taskStatus === 'running' && (
        <>
          <Button onClick={handlePause}>{t('home:pauseTask')}</Button>
          <Button onClick={handleCancel}>{t('home:cancelTask')}</Button>
        </>
      )}
      {taskStatus === 'paused' && (
        <>
          <Button onClick={handleResume}>{t('home:resumeTask')}</Button>
          <Button onClick={handleCancel}>{t('home:cancelTask')}</Button>
        </>
      )}
      {taskStatus === 'cancelled' && (
        <Button onClick={handleTask} disabled={!files.length}>
          {t('home:restartTask')}
        </Button>
      )}
    </div>
  );
};

export default TaskControls;

import {
  useEffect,
  useState,
  type Dispatch,
  type FC,
  type SetStateAction,
} from 'react';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { getNewTaskFiles, needsCoreML } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import type { IFiles } from '../../types';
import { Switch } from './ui/switch';
import useLocalStorageState from 'hooks/useLocalStorageState';
import { useUpdateEffect } from 'ahooks';

type TaskStatus = 'idle' | 'running' | 'paused' | 'cancelled' | 'completed';

const TaskControls: FC<{
  files: IFiles[];
  setFiles: Dispatch<SetStateAction<IFiles[]>>;
  formData: any;
}> = ({ files, setFiles, formData }) => {
  const [taskStatus, setTaskStatus] = useState<TaskStatus>('idle');
  const { t } = useTranslation(['home', 'common']);
  const [autoStartNewTaskWhenRunning, setAutoStartNewTaskWhenRunning] =
    useLocalStorageState<boolean>('auto-start-new-task-when-running', false);

  useEffect(() => {
    // 获取当前任务状态
    const getCurrentTaskStatus = async () => {
      const status = await window?.ipc?.invoke('getTaskStatus');
      setTaskStatus(status);
    };
    getCurrentTaskStatus();

    // 监听任务状态变化
    const cleanup = window?.ipc?.on('taskComplete', (status: TaskStatus) => {
      setTaskStatus(status);
    });

    return () => {
      cleanup?.();
    };
  }, []);

  const handleTask = async (options?: { silentNoNewTask?: boolean }) => {
    if (!files?.length) {
      return toast(t('common:notification'), { description: t('home:noTask') });
    }

    // when start task button pressed, persist taskType to IFiles
    const needPersist = files.some((f) => !f.taskType);
    let updatedFiles = files;
    if (needPersist) {
      updatedFiles = files.map((f) => {
        if (f.taskType) return f;
        return { ...f, taskType: formData.taskType };
      });
      setFiles(updatedFiles);
    }

    const newTaskFiles = getNewTaskFiles(updatedFiles);
    if (!newTaskFiles.length) {
      if (!options?.silentNoNewTask) {
        toast(t('common:notification'), {
          description: t('home:allFilesProcessed'),
        });
      }
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

    setTaskStatus('running');
    setFiles((files) =>
      files.map((f) => {
        if (f.sent) return f;
        return { ...f, sent: true };
      }),
    );
    window?.ipc?.send('handleTask', { files: newTaskFiles, formData });
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

  useUpdateEffect(() => {
    if (
      taskStatus === 'running' &&
      autoStartNewTaskWhenRunning &&
      files.length
    ) {
      handleTask({ silentNoNewTask: true });
    }
  }, [files.length]);

  return (
    <div className="flex gap-2 ml-auto">
      {(taskStatus === 'idle' || taskStatus === 'completed') && (
        <Button onClick={() => handleTask()} disabled={!files.length}>
          {t('home:startTask')}
        </Button>
      )}
      {taskStatus === 'running' && (
        <>
          <span className="inline-flex items-center justify-center gap-x-1 mr-1">
            <Switch
              id="auto-start-new-task-when-running"
              checked={autoStartNewTaskWhenRunning}
              onCheckedChange={setAutoStartNewTaskWhenRunning}
            />
            <label
              htmlFor="auto-start-new-task-when-running"
              className="cursor-pointer select-none"
            >
              {t('home:autoStartNewTaskWhenRunning')}
            </label>
          </span>
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
        <Button onClick={() => handleTask()} disabled={!files.length}>
          {t('home:restartTask')}
        </Button>
      )}
    </div>
  );
};

export default TaskControls;

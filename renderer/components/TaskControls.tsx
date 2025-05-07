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
import type { ITaskFile } from '../../types';

const TaskControls: FC<{
  files: ITaskFile[];
  setFiles: Dispatch<SetStateAction<ITaskFile[]>>;
  formData: any;
}> = ({ files, setFiles, formData }) => {
  const [taskStatus, setTaskStatus] = useState('idle');
  const { t } = useTranslation(['home', 'common']);

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

  const handleTask = async () => {
    if (!files?.length) {
      return toast(t('common:notification'), { description: t('home:noTask') });
    }

    // when start task button pressed, persist task config to ITaskFile
    const updatedFiles = files.map((f) => {
      return { formData, taskType: formData.taskType, ...f };
    });
    setFiles(updatedFiles);

    const newTaskFiles = getNewTaskFiles(updatedFiles);
    if (!newTaskFiles.length) {
      return toast(t('common:notification'), {
        description: t('home:allFilesProcessed'),
      });
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
  return (
    <div className="flex gap-2 ml-auto">
      {(taskStatus === 'idle' || taskStatus === 'completed') && (
        <Button onClick={handleTask} disabled={!files.length}>
          {t('home:startTask')}
        </Button>
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

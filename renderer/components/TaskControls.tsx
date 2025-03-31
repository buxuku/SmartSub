import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { isSubtitleFile, needsCoreML } from 'lib/utils';
import { useTranslation } from 'next-i18next';

const TaskControls = ({ files, formData }) => {
  const [taskStatus, setTaskStatus] = useState('idle');
  const { t } = useTranslation(['home', 'common']);
  useEffect(() => {
    window?.ipc?.on('taskComplete', (status: string) => {
      setTaskStatus(status);
    });
  }, []);
  const handleTask = async () => {
    if (!files?.length) {
      toast(t('common:notification'), {
        description: t('home:noTask'),
      });
      return;
    }
    const isAllFilesProcessed = files.every((item) => {
      const basicProcessingDone = item.extractAudio && item.extractSubtitle;

      if (formData.translateProvider === '-1') {
        return basicProcessingDone;
      }
      if (isSubtitleFile(item?.filePath)) {
        return item.translateSubtitle;
      }

      return basicProcessingDone && item.translateSubtitle;
    });

    if (isAllFilesProcessed) {
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
    setTaskStatus('running');
    window?.ipc?.send('handleTask', { files, formData });
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

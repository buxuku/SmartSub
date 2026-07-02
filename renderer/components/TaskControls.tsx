import { useEffect, useRef, useState } from 'react';
import { CircleStop, Cloud, Loader2, Pause, Play } from 'lucide-react';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import type { TaskTypeDef } from 'lib/taskTypes';
import { getFileStages, isFileDone } from './tasks/stageUtils';
import { useHotkeys } from 'hooks/useHotkeys';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

interface TaskControlsProps {
  files: any[];
  formData: any;
  typeDef: TaskTypeDef;
  projectId: string | null;
  className?: string;
  /** 可选：状态变化时上抛（任务页用于联动重试按钮/完成横幅） */
  onStatusChange?: (status: string) => void;
  autoStart?: boolean;
}

type TaskCompletePayload = { projectId?: string; status?: string } | string;

const TaskControls = ({
  files,
  formData,
  typeDef,
  projectId,
  className,
  onStatusChange,
  autoStart,
}: TaskControlsProps) => {
  const [taskStatus, setTaskStatusState] = useState('idle');
  // 首次状态同步是否已完成:autostart 必须等它,否则迟到的 'idle' 会覆盖乐观 'running'
  const [statusSynced, setStatusSynced] = useState(false);
  // 云端听写「上传确认」：首次开跑云任务时弹确认，勾选不再提醒后写入 settings。
  const [cloudConsentOpen, setCloudConsentOpen] = useState(false);
  const pendingCloudFilesRef = useRef<any[] | null>(null);
  const { t } = useTranslation(['home', 'common']);

  const setTaskStatus = (status: string) => {
    setTaskStatusState(status);
    onStatusChange?.(status);
  };

  useEffect(() => {
    setStatusSynced(false);
    if (!projectId) return;
    let disposed = false;
    // 获取当前工程的任务状态
    const getCurrentTaskStatus = async () => {
      const status = await window?.ipc?.invoke('getTaskStatus', projectId);
      if (!disposed && status) setTaskStatus(status);
      if (!disposed) setStatusSynced(true);
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
    // 带翻译的任务必须有有效翻译服务商（'-1' 为历史「不翻译」残留值）
    if (typeDef.hasTranslate) {
      const provider = formData?.translateProvider;
      if (!provider || provider === '-1') {
        toast.error(t('home:selectProviderFirst'));
        return;
      }
    }
    // 需要模型的任务必须已选模型：自动选择兜底后仍为空，说明确实没有可用模型，拦截并指引下载
    if (typeDef.needsModel && !formData?.model) {
      toast.error(t('home:selectModelFirst'));
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
    // 云端听写：音频会上传到第三方端点，首次开跑前弹确认（隐私/成本护栏）。
    if (typeDef.needsModel && formData?.transcriptionEngine === 'cloud') {
      const settings = await window?.ipc?.invoke('getSettings');
      if (!settings?.cloudUploadConsent) {
        pendingCloudFilesRef.current = pendingFiles;
        setCloudConsentOpen(true);
        return;
      }
    }
    dispatchTask(pendingFiles);
  };

  // 记录"上次使用"的 (引擎,模型[,云实例]) 并派发任务。
  const dispatchTask = (pendingFiles: any[]) => {
    if (
      typeDef.needsModel &&
      formData?.transcriptionEngine &&
      formData?.model
    ) {
      window?.ipc?.invoke('setSettings', {
        lastUsedTranscription: {
          engine: formData.transcriptionEngine,
          model: formData.model,
          ...(formData.transcriptionEngine === 'cloud'
            ? { asrProviderId: formData.asrProviderId }
            : {}),
        },
      });
    }
    setTaskStatus('running');
    window?.ipc?.send('handleTask', {
      files: pendingFiles,
      formData,
      projectId,
    });
  };

  const handleConfirmCloudConsent = async (remember: boolean) => {
    setCloudConsentOpen(false);
    if (remember) {
      try {
        await window?.ipc?.invoke('setSettings', { cloudUploadConsent: true });
      } catch {
        // 忽略：确认后仍继续本次任务，仅"不再提醒"落库失败
      }
    }
    const files = pendingCloudFilesRef.current;
    pendingCloudFilesRef.current = null;
    if (files?.length) dispatchTask(files);
  };

  // ?autostart=1 进入页面时自动开始一次(仅 idle 态,ref 防 StrictMode/重渲染重复触发)
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!statusSynced) return;
    if (!autoStart || autoStartedRef.current) return;
    if (!files?.length) return;
    if (taskStatus !== 'idle') return;
    autoStartedRef.current = true;
    handleTask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, files, taskStatus, statusSynced]);

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
        <Button
          className="gap-1.5"
          onClick={handleTask}
          disabled={!files.length}
        >
          <Play className="h-4 w-4" />
          {taskStatus === 'cancelled'
            ? t('home:restartTask')
            : t('home:startTask')}
        </Button>
      )}
      {taskStatus === 'running' && (
        <>
          <Button
            className="gap-1.5"
            onClick={handlePause}
            title={t('home:pauseTip')}
          >
            <Pause className="h-4 w-4" />
            {t('home:pauseTask')}
          </Button>
          <Button className="gap-1.5" onClick={handleCancel}>
            <CircleStop className="h-4 w-4" />
            {t('home:cancelTask')}
          </Button>
        </>
      )}
      {taskStatus === 'paused' && (
        <>
          <Button className="gap-1.5" onClick={handleResume}>
            <Play className="h-4 w-4" />
            {t('home:resumeTask')}
          </Button>
          <Button className="gap-1.5" onClick={handleCancel}>
            <CircleStop className="h-4 w-4" />
            {t('home:cancelTask')}
          </Button>
        </>
      )}
      {taskStatus === 'cancelling' && (
        <Button className="gap-1.5" disabled>
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('home:cancelling')}
        </Button>
      )}

      <AlertDialog open={cloudConsentOpen} onOpenChange={setCloudConsentOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Cloud className="h-5 w-5 text-sky-500" />
              {t('home:cloudConsent.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('home:cloudConsent.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            <AlertDialogCancel
              onClick={() => {
                pendingCloudFilesRef.current = null;
              }}
            >
              {t('common:cancel')}
            </AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => handleConfirmCloudConsent(false)}
            >
              {t('home:cloudConsent.confirmOnce')}
            </Button>
            <AlertDialogAction onClick={() => handleConfirmCloudConsent(true)}>
              {t('home:cloudConsent.confirmRemember')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TaskControls;

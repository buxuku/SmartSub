import { useEffect, useRef, useState } from 'react';
import { CircleStop, Loader2, Pause, Play } from 'lucide-react';
import { Button } from './ui/button';
import { toast } from 'sonner';
import { cn, isSubtitleFile } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import type { TaskTypeDef } from 'lib/taskTypes';
import { getFileStages, isFileDone } from './tasks/stageUtils';
import { useHotkeys } from 'hooks/useHotkeys';
import { useTaskSubmission } from 'hooks/useTaskSubmission';
import { buildTaskSnapshotFromConfig } from 'hooks/useUnifiedTaskConfig';
import { getRefineValidationErrorMessage } from 'lib/subtitleRefineValidation';
import { validateSummaryProvider } from '../../types/summaryProvider';

interface TaskControlsProps {
  files: any[];
  formData: any;
  typeDef: TaskTypeDef;
  projectId: string | null;
  className?: string;
  /** 可选：当阻断原因是精修配置异常时，唤起精修配置弹层并滚动聚焦 */
  onOpenRefine?: () => void;
  /** 可选：状态变化时上抛（任务页用于联动重试按钮/完成横幅） */
  onStatusChange?: (status: string) => void;
  /** 任务成功派发时回传本轮配置；需要固定快照的任务可立即切换为只读展示。 */
  onTaskDispatched?: (snapshot: any) => void;
  autoStart?: boolean;
  ready?: boolean;
  beforeStart?: () => Promise<boolean>;
}

type TaskCompletePayload = { projectId?: string; status?: string } | string;

const TaskControls = ({
  files,
  formData,
  typeDef,
  projectId,
  className,
  onOpenRefine,
  onStatusChange,
  onTaskDispatched,
  autoStart,
  ready = true,
  beforeStart,
}: TaskControlsProps) => {
  const [taskStatus, setTaskStatusState] = useState('idle');
  const submission = useTaskSubmission();
  const { starting } = submission;
  // 首次状态同步是否已完成:autostart 必须等它,否则迟到的 'idle' 会覆盖乐观 'running'
  const [statusSynced, setStatusSynced] = useState(false);
  const { t } = useTranslation(['home', 'common', 'tasks']);

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
    if (starting || !ready) return;
    try {
      if (beforeStart && !(await beforeStart())) return;
      if (!files?.length) {
        toast(t('common:notification'), {
          description: t('home:noTask'),
        });
        return;
      }
      if (
        typeDef.accepts === 'subtitle' &&
        files.some((file) => !isSubtitleFile(file?.filePath?.toLowerCase()))
      ) {
        toast.error(t('tasks:subtitleFilesRequired'));
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
      if (typeDef.hasTranslate && formData?.generateSummary === true) {
        const summaryProviders =
          (await window?.ipc?.invoke('getTranslationProviders')) || [];
        const summaryBlock = validateSummaryProvider(
          formData,
          summaryProviders,
        );
        if (summaryBlock === 'follow') {
          toast.error(t('tasks:wizard.blockSummaryFollow'));
          return;
        }
        if (summaryBlock === 'invalid') {
          toast.error(t('tasks:wizard.blockSummaryProviderInvalid'));
          return;
        }
      }
      const snapshot = buildTaskSnapshotFromConfig(formData);
      const outcome = await submission.submit({
        projectId,
        files: pendingFiles,
        typeDef,
        formData: { ...snapshot, taskType: typeDef.taskType },
      });
      if (outcome.status === 'invalid') {
        const { readiness } = outcome;
        if (!readiness.refine.valid) {
          const msg = getRefineValidationErrorMessage(
            readiness.refine,
            (key: string, opts?: any) => String(t(`tasks:${key}` as any, opts)),
            (key: string, opts?: any) =>
              String(t(`common:${key}` as any, opts)),
          );
          toast.error(msg, {
            action: onOpenRefine
              ? {
                  label: t('tasks:wizard.refineActionAdjust'),
                  onClick: onOpenRefine,
                }
              : undefined,
          });
          onOpenRefine?.();
        } else {
          toast.error(t(`tasks:readiness.${readiness.errors[0]}` as any));
        }
        return;
      }
      if (outcome.status !== 'accepted') return;
      rememberSelection(snapshot);
      onTaskDispatched?.(outcome.snapshot);
      const status = await window.ipc.invoke('getTaskStatus', projectId);
      setTaskStatus(status || 'idle');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  // 记录"上次使用"的 (引擎,模型[,云实例]) 并派发任务。
  const rememberSelection = (snapshot: Record<string, any>) => {
    if (typeDef.needsModel && snapshot.transcriptionEngine && snapshot.model) {
      void window?.ipc
        ?.invoke('setSettings', {
          lastUsedTranscription: {
            engine: snapshot.transcriptionEngine,
            model: snapshot.model,
            ...(snapshot.transcriptionEngine === 'cloud'
              ? { asrProviderId: snapshot.asrProviderId }
              : {}),
          },
        })
        .catch((error) =>
          console.error('Failed to remember transcription selection:', error),
        );
    }
  };

  // ?autostart=1 进入页面时自动开始一次(仅 idle 态,ref 防 StrictMode/重渲染重复触发)
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!statusSynced || !ready) return;
    if (!autoStart || autoStartedRef.current) return;
    if (!files?.length) return;
    if (taskStatus !== 'idle') return;
    autoStartedRef.current = true;
    handleTask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, files, taskStatus, statusSynced, ready]);

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
          disabled={!files.length || starting || !ready}
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

      {submission.dialog}
    </div>
  );
};

export default TaskControls;

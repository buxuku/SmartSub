import React, { useRef } from 'react';
import {
  Captions,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Edit2,
  FileUp,
  FolderOpen,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from 'lib/utils';
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTranslation } from 'next-i18next';
import {
  getFileStages,
  getStageStatus,
  getFilePercent,
  getFileError,
  hasFileError,
  isProofreadReady,
  getProofreadUnavailableReason,
  getRevealPath,
  formatBytes,
  formatMediaDuration,
  type StageDef,
} from './stageUtils';

interface TaskRowListProps {
  files: any[];
  typeDef: TaskTypeDef;
  formData: any;
  taskStatus: string;
  onProofread: (file: any) => void;
  onDelete: (uuid: string) => void;
  onRetry: (file: any) => void;
}

function StageChips({
  file,
  stages,
  t,
}: {
  file: any;
  stages: StageDef[];
  t: (key: string) => string;
}) {
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      {stages.map((stage, index) => {
        const status = getStageStatus(file, stage.key);
        return (
          <React.Fragment key={stage.key}>
            {index > 0 && (
              <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            )}
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs whitespace-nowrap',
                status === 'pending' && 'text-muted-foreground/60',
                status === 'loading' && 'text-primary font-medium',
                status === 'done' && 'text-success',
                status === 'error' && 'text-destructive font-medium',
              )}
            >
              {status === 'loading' && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              {status === 'done' && <CheckCircle2 className="h-3 w-3" />}
              {status === 'error' && <CircleAlert className="h-3 w-3" />}
              {t(stage.labelKey)}
              {status === 'loading' &&
                stage.key === 'extractSubtitle' &&
                file.whisperBackend && (
                  <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground">
                    {file.whisperBackend}
                  </span>
                )}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

const TaskRowList: React.FC<TaskRowListProps> = ({
  files,
  typeDef,
  formData,
  taskStatus,
  onProofread,
  onDelete,
  onRetry,
}) => {
  const { t } = useTranslation('tasks');
  const queueBusy =
    taskStatus === 'running' ||
    taskStatus === 'paused' ||
    taskStatus === 'cancelling';

  // 单文件 ETA：记录当前 loading 阶段首次观察到的时间与进度，按速率粗估剩余
  const etaRef = useRef<
    Record<string, { stage: string; t0: number; p0: number }>
  >({});

  const getEtaMinutes = (file: any, stages: StageDef[]): number | null => {
    const uuid = file?.uuid;
    if (!uuid) return null;
    const loadingStage = stages.find(
      (s) => getStageStatus(file, s.key) === 'loading',
    );
    if (!loadingStage) {
      delete etaRef.current[uuid];
      return null;
    }
    const percent = Number(file?.[`${loadingStage.key}Progress`] || 0);
    const rec = etaRef.current[uuid];
    if (!rec || rec.stage !== loadingStage.key || percent < rec.p0) {
      etaRef.current[uuid] = {
        stage: loadingStage.key,
        t0: Date.now(),
        p0: percent,
      };
      return null;
    }
    const dp = percent - rec.p0;
    // 至少观察到 5 个百分点的推进才给估算，避免初期乱跳
    if (dp < 5 || percent >= 100) return null;
    const elapsed = Date.now() - rec.t0;
    if (elapsed <= 0) return null;
    return ((elapsed / dp) * (100 - percent)) / 60000;
  };

  const handleImport = () => {
    const fileType = typeDef.accepts === 'subtitle' ? 'srt' : 'media';
    window?.ipc?.send('openDialog', { dialogType: 'openDialog', fileType });
  };

  const handleOpenFolder = (file: any) => {
    const filePath = getRevealPath(file);
    if (filePath) {
      window?.ipc?.invoke('subtitleMerge:openOutputFolder', { filePath });
    }
  };

  if (!files.length) {
    return (
      <div
        className="flex flex-col cursor-pointer items-center justify-center h-[360px] border-2 border-dashed rounded-lg p-8"
        onClick={handleImport}
      >
        <FileUp className="w-14 h-14 text-muted-foreground/50 mb-4" />
        <p className="text-base text-center text-muted-foreground mb-1">
          {typeDef.accepts === 'subtitle'
            ? t('empty.dragSubtitle')
            : t('empty.dragMedia')}
        </p>
        <p className="text-xs text-center text-muted-foreground/70">
          {typeDef.accepts === 'subtitle'
            ? t('empty.subtitleFormats')
            : t('empty.mediaFormats')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {files.map((file) => {
        const stages = getFileStages(file, typeDef, formData);
        const percent = getFilePercent(file, stages);
        const failed = hasFileError(file, stages);
        const rawError = failed ? getFileError(file, stages) : '';
        const errorMsg =
          rawError === 'TASK_INTERRUPTED' ? t('interrupted') : rawError;
        const started = stages.some(
          (s) => getStageStatus(file, s.key) !== 'pending',
        );
        const cancelling =
          taskStatus === 'cancelling' &&
          stages.some((s) => getStageStatus(file, s.key) === 'loading');
        const meta = [
          formatBytes(file?.fileSize),
          formatMediaDuration(file?.duration),
        ]
          .filter(Boolean)
          .join(' · ');
        const etaMinutes = getEtaMinutes(file, stages);
        const proofreadUnavailableReason = getProofreadUnavailableReason(
          file,
          typeDef,
        );
        const proofreadDisabled =
          !isProofreadReady(file, typeDef) ||
          proofreadUnavailableReason !== null;
        const proofreadTooltip =
          proofreadUnavailableReason === 'txt'
            ? t('row.proofreadTxtUnsupported')
            : t('row.proofread');

        return (
          <div
            key={file?.uuid}
            className={cn(
              'group rounded-lg border px-3 py-2.5 transition-colors hover:bg-muted/40',
              failed && 'border-destructive/30',
            )}
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <button
                  type="button"
                  aria-label={t('row.remove')}
                  className="flex-shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded transition-opacity text-muted-foreground hover:text-destructive disabled:cursor-not-allowed disabled:opacity-0 disabled:group-hover:opacity-30 disabled:hover:text-muted-foreground"
                  disabled={queueBusy}
                  onClick={() => onDelete(file?.uuid)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default truncate text-sm font-medium min-w-0">
                        {file?.fileName}
                        {file?.fileExtension}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-md">
                      <p className="break-all">{file?.filePath}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {file?.embeddedSubtitle && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex-shrink-0 text-primary">
                          <Captions className="h-3.5 w-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs">
                        {t('row.embeddedSubtitle')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                {meta && (
                  <span className="hidden md:inline text-[11px] text-muted-foreground whitespace-nowrap flex-shrink-0">
                    {meta}
                  </span>
                )}
              </div>

              <StageChips file={file} stages={stages} t={t} />

              <div className="flex items-center gap-2 w-[160px] flex-shrink-0">
                <Progress value={percent} className="h-1.5" />
                <span className="text-[11px] tabular-nums text-muted-foreground w-[34px] text-right">
                  {started ? `${percent}%` : '--'}
                </span>
              </div>
              {etaMinutes != null && (
                <span className="text-[11px] text-muted-foreground whitespace-nowrap flex-shrink-0">
                  {etaMinutes < 1
                    ? t('meta.etaLessMin')
                    : t('meta.etaMin', { min: Math.ceil(etaMinutes) })}
                </span>
              )}

              <div className="flex items-center gap-1 flex-shrink-0">
                {failed && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    disabled={queueBusy}
                    onClick={() => onRetry(file)}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t('row.retry')}
                  </Button>
                )}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          aria-label={t('row.proofread')}
                          disabled={proofreadDisabled}
                          onClick={() => onProofread(file)}
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[280px]">
                      {proofreadTooltip}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t('row.openFolder')}
                        onClick={() => handleOpenFolder(file)}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('row.openFolder')}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>

            {cancelling && (
              <p className="mt-1.5 pl-5 text-xs text-warning">
                {t('row.cancelling')}
              </p>
            )}

            {failed && errorMsg && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="mt-1.5 pl-5 text-xs text-destructive truncate cursor-default">
                      {errorMsg}
                    </p>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-md">
                    <p className="break-all">{errorMsg}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default TaskRowList;

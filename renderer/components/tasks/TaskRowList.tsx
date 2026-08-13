import { TaskActivityDetails } from './TaskActivityDetails';
import React, { useRef } from 'react';
import {
  AudioLines,
  Captions,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Diamond,
  Edit2,
  FileText,
  FileUp,
  FolderOpen,
  Loader2,
  Play,
  RotateCcw,
  Settings2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import StepGuide from '@/components/StepGuide';
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
  getFileRail,
  getStageStatus,
  getTaskDisplayStatus,
  getGateStatus,
  getDockedGate,
  getFilePercent,
  getFileError,
  getFileWarning,
  hasFileError,
  isProofreadReady,
  getProofreadUnavailableReason,
  getRevealPath,
  formatBytes,
  formatMediaDuration,
  type RailItem,
  type StageDef,
} from './stageUtils';
import { formatTaskMessage } from './taskMessages';
import { ManuscriptRowBadge } from './ManuscriptRowBadge';
import { SpeechReviewBadge } from './SpeechReviewBadge';

interface TaskRowListProps {
  files: any[];
  typeDef: TaskTypeDef;
  formData: any;
  taskStatus: string;
  manuscriptPool?: any[];
  onProofread: (file: any) => void;
  onDelete: (uuid: string) => void;
  onRetry: (file: any) => void;
  /** 放行停靠在检查点的文件 */
  onReleaseGate?: (file: any, gate: 'subtitle' | 'dubbing') => void;
  /** 打开配音工作台检查该文件的配音 */
  onInspectDubbing?: (file: any) => void;
  onAssignManuscript?: (
    file: any,
    manuscriptPath: string,
    manuscriptName?: string,
  ) => void;
  onImport?: () => void;
}

export function RailChips({
  file,
  rail,
  t,
  className,
}: {
  file: any;
  rail: RailItem[];
  t: (key: string, options?: Record<string, unknown>) => string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-1 flex-shrink-0', className)}>
      {rail.map((item, index) => {
        if (item.kind === 'gate') {
          const status = getGateStatus(file, item.gate.key);
          return (
            <React.Fragment key={item.gate.key}>
              {index > 0 && <ChevronRight className="h-3 w-3 text-faint" />}
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-xs whitespace-nowrap',
                  status === 'pending' && 'text-faint',
                  status === 'review' && 'text-warning font-medium',
                  status === 'passed' && 'text-success',
                )}
                title={
                  status === 'review' ? t('gate.reviewTooltip') : undefined
                }
              >
                <Diamond
                  className={cn(
                    'h-3 w-3',
                    status === 'review' && 'animate-pulse fill-warning/30',
                    status === 'passed' && 'fill-success/30',
                  )}
                />
                {status === 'review'
                  ? t('gate.reviewBadge')
                  : t(item.gate.labelKey)}
              </span>
            </React.Fragment>
          );
        }
        const stage = item.stage;
        const status = getStageStatus(file, stage.key);
        const manuscriptSummary =
          stage.key === 'manuscriptMatch' ? file?.manuscriptMatchSummary : null;
        const manuscriptWarning =
          stage.key === 'manuscriptMatch' && status === 'done'
            ? file?.manuscriptMatchError
            : '';
        const manuscriptWarningReason = manuscriptWarning
          ? t(`manuscript.error.${manuscriptWarning}`, {
              defaultValue:
                file?.manuscriptMatchErrorDetail || manuscriptWarning,
            })
          : '';
        const manuscriptTitle = manuscriptWarning
          ? t('manuscript.stageWarning', {
              reason: manuscriptWarningReason,
            })
          : manuscriptSummary
            ? t('manuscript.stageSummary', {
                replaced: manuscriptSummary.replacedCues,
                total: manuscriptSummary.totalCues,
                confidence: Math.round(
                  Number(manuscriptSummary.averageConfidence || 0) * 100,
                ),
              })
            : undefined;
        const missedSpeechSummary = file?.missedSpeechSummary;
        const missedSpeechTitle = missedSpeechSummary?.count
          ? t('row.missedSpeechWarning', {
              count: missedSpeechSummary.count,
              level: t(
                `row.missedSpeechLevel.${missedSpeechSummary.highestLevel || 'low'}`,
              ),
            })
          : undefined;
        const translationFailureCount = file?.translationFailures?.length || 0;
        const translationFailureTitle = translationFailureCount
          ? t('row.translationFailureWarning', {
              count: translationFailureCount,
            })
          : undefined;
        const stageWarning = Boolean(file?.[`${stage.key}Error`]);
        const summarizeWarning =
          stage.key === 'summarizeEpisode' && status === 'done'
            ? file?.summarizeEpisodeError
            : '';
        const summarizeTitle = summarizeWarning
          ? t(`summarize.error.${summarizeWarning}`, {
              defaultValue: summarizeWarning,
            })
          : undefined;
        return (
          <React.Fragment key={stage.key}>
            {index > 0 && <ChevronRight className="h-3 w-3 text-faint" />}
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs whitespace-nowrap',
                status === 'pending' && 'text-faint',
                status === 'loading' && 'text-primary font-medium',
                status === 'done' &&
                  (stageWarning ? 'text-warning' : 'text-success'),
                status === 'error' && 'text-destructive font-medium',
              )}
              title={
                stage.key === 'extractSubtitle' && missedSpeechTitle
                  ? missedSpeechTitle
                  : stage.key === 'translateSubtitle' && translationFailureTitle
                    ? translationFailureTitle
                    : summarizeTitle || manuscriptTitle
              }
            >
              {status === 'loading' && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              {status === 'done' &&
                (stageWarning ? (
                  <CircleAlert className="h-3 w-3" />
                ) : (
                  <CheckCircle2 className="h-3 w-3" />
                ))}
              {status === 'error' && <CircleAlert className="h-3 w-3" />}
              {stage.key === 'extractSubtitle' &&
              status === 'loading' &&
              file.speechReviewStage
                ? t('row.speechReviewing')
                : t(stage.labelKey)}
              {stage.key === 'extractSubtitle' && status === 'done' ? (
                <SpeechReviewBadge file={file} />
              ) : null}
              {status === 'done' && manuscriptSummary && (
                <span className="text-[10px]">
                  {manuscriptSummary.replacedCues}/{manuscriptSummary.totalCues}
                </span>
              )}
              {status === 'loading' &&
                stage.key === 'extractSubtitle' &&
                file.whisperBackend && (
                  <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground">
                    {file.whisperBackend}
                  </span>
                )}
              {stage.key === 'extractSubtitle' && missedSpeechSummary?.count ? (
                <span
                  className="inline-flex items-center gap-0.5 text-warning"
                  title={missedSpeechTitle}
                >
                  <CircleAlert className="h-3 w-3" />
                  <span className="text-[10px]">
                    {missedSpeechSummary.count}
                  </span>
                </span>
              ) : null}
              {stage.key === 'translateSubtitle' &&
              translationFailureCount > 0 ? (
                <span
                  className="inline-flex items-center gap-0.5 text-warning"
                  title={translationFailureTitle}
                >
                  <CircleAlert className="h-3 w-3" />
                  <span className="text-[10px]">{translationFailureCount}</span>
                </span>
              ) : null}
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
  manuscriptPool,
  onProofread,
  onDelete,
  onRetry,
  onReleaseGate,
  onInspectDubbing,
  onAssignManuscript,
  onImport,
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
    if (onImport) {
      onImport();
      return;
    }
    const fileType =
      typeDef.accepts === 'subtitle'
        ? 'srt'
        : typeDef.needsModel
          ? 'media-and-manuscript'
          : 'media';
    window?.ipc?.send('openDialog', { dialogType: 'openDialog', fileType });
  };

  const handleOpenFolder = (file: any) => {
    const filePath = getRevealPath(file);
    if (filePath) {
      window?.ipc?.invoke('subtitleMerge:openOutputFolder', { filePath });
    }
  };

  if (!files.length) {
    // 空态：统一三步引导（P0 动线统一，与配音/合成页同形态）
    const subtitleInput = typeDef.accepts === 'subtitle';
    const canAcceptManuscript = !subtitleInput && Boolean(typeDef.needsModel);
    return (
      <div
        className="h-[380px] cursor-pointer rounded-lg border-2 border-dashed border-border-strong transition-colors hover:border-primary/50"
        onClick={handleImport}
      >
        <StepGuide
          steps={[
            {
              icon: FileUp,
              title: t('empty.step1'),
              desc: subtitleInput
                ? t('empty.subtitleFormats')
                : canAcceptManuscript
                  ? t('empty.mediaAndManuscriptFormats')
                  : t('empty.mediaFormats'),
            },
            {
              icon: Settings2,
              title: t('empty.step2'),
              desc: t('empty.step2Desc'),
            },
            {
              icon: Play,
              title: t('empty.step3'),
              desc: t('empty.step3Desc'),
            },
          ]}
          actions={
            <div className="flex flex-col items-center gap-2">
              {Boolean(canAcceptManuscript && manuscriptPool?.length) && (
                <div className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                  <FileText className="h-3.5 w-3.5" />
                  <span>
                    {t('manuscript.emptyWaitingVideos', {
                      count: manuscriptPool!.length,
                    })}
                  </span>
                </div>
              )}
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  handleImport();
                }}
              >
                <FileUp className="h-4 w-4" />
                {t('import')}
              </Button>
            </div>
          }
          dropHint={
            subtitleInput
              ? t('empty.dragSubtitle')
              : canAcceptManuscript
                ? t('empty.dragMediaAndManuscript')
                : t('empty.dragMedia')
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {files.map((file) => {
        const stages = getFileStages(file, typeDef, formData);
        const rail = getFileRail(file, typeDef, formData);
        const dockedGate = getDockedGate(file, formData);
        const status = getTaskDisplayStatus(
          file,
          stages,
          taskStatus,
          dockedGate,
        );
        const percent = getFilePercent(file, stages);
        const failed = hasFileError(file, stages);
        const rawError = failed ? getFileError(file, stages) : '';
        const errorMsg = formatTaskMessage(
          rawError,
          t,
          file?.translationFailures?.length || 0,
        );
        const warningMsg = formatTaskMessage(
          getFileWarning(file, stages),
          t,
          file?.translationFailures?.length || 0,
        );
        const missedSpeechWarning = file?.missedSpeechSummary?.count
          ? t('row.missedSpeechWarning', {
              count: file.missedSpeechSummary.count,
              level: t(
                `row.missedSpeechLevel.${file.missedSpeechSummary.highestLevel || 'low'}`,
              ),
            })
          : '';
        const translationFailureWarning =
          !failed && file?.translationFailures?.length
            ? t('row.translationFailureWarning', {
                count: file.translationFailures.length,
              })
            : '';
        const displayWarning = [
          warningMsg,
          missedSpeechWarning,
          translationFailureWarning,
        ]
          .filter(Boolean)
          .join(' · ');
        const started = stages.some(
          (s) => getStageStatus(file, s.key) !== 'pending',
        );
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
          !isProofreadReady(file, typeDef, formData) ||
          proofreadUnavailableReason !== null;
        const proofreadTooltip =
          proofreadUnavailableReason === 'txt'
            ? t('row.proofreadTxtUnsupported')
            : t('row.proofread');

        return (
          <div
            key={file?.uuid}
            className={cn(
              'group rounded-lg border border-transparent bg-card px-3 py-2.5 transition-colors hover:bg-muted/40',
              failed && 'border-destructive/30',
              !failed && displayWarning && 'border-warning/30',
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
                {typeDef?.needsModel && (
                  <ManuscriptRowBadge
                    file={file}
                    formData={formData}
                    disabled={queueBusy}
                    manuscriptPool={manuscriptPool}
                    onAssignManuscript={onAssignManuscript}
                  />
                )}
                {meta && (
                  <span className="hidden md:inline text-[11px] text-muted-foreground whitespace-nowrap flex-shrink-0">
                    {meta}
                  </span>
                )}
              </div>

              <RailChips file={file} rail={rail} t={t} />

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
                {/* 停靠在检查点：校对/检查配音 + 放行 */}
                {dockedGate && (
                  <>
                    {dockedGate.key === 'subtitleGate' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1 border-warning/50 text-warning hover:text-warning"
                        onClick={() => onProofread(file)}
                      >
                        <Edit2 className="h-3 w-3" />
                        {t('gate.review')}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1 border-warning/50 text-warning hover:text-warning"
                        onClick={() => onInspectDubbing?.(file)}
                      >
                        <AudioLines className="h-3 w-3" />
                        {t('gate.inspectDubbing')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() =>
                        onReleaseGate?.(
                          file,
                          dockedGate.key === 'subtitleGate'
                            ? 'subtitle'
                            : 'dubbing',
                        )
                      }
                    >
                      <Play className="h-3 w-3" />
                      {t('gate.release')}
                    </Button>
                  </>
                )}
                {failed &&
                  file.dubbingSessionId &&
                  onInspectDubbing &&
                  !dockedGate && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      disabled={queueBusy}
                      onClick={() => onInspectDubbing(file)}
                    >
                      <AudioLines className="h-3 w-3" />
                      {t('gate.inspectDubbing')}
                    </Button>
                  )}
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

            <TaskActivityDetails
              activity={file.taskActivity}
              state={status.state}
              stage={status.stage}
              statusText={
                errorMsg ||
                t(`activity.status.${status.state}`, {
                  stage: status.labelKey ? t(status.labelKey) : '',
                })
              }
              warning={displayWarning}
              progress={
                file.taskActivity?.stage
                  ? file[`${file.taskActivity.stage}Progress`]
                  : undefined
              }
            />
          </div>
        );
      })}
    </div>
  );
};

export default TaskRowList;

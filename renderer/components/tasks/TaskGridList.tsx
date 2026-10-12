import { TaskActivityDetails } from './TaskActivityDetails';
import React, { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Captions,
  CheckCircle2,
  CircleAlert,
  Clapperboard,
  Edit2,
  FileText,
  FileUp,
  FolderOpen,
  Loader2,
  Music,
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
import { cn, isSubtitleFile, isAudioPath } from 'lib/utils';
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTranslation } from 'next-i18next';
import {
  getFileStages,
  getFileRail,
  getStageStatus,
  getTaskDisplayStatus,
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
} from './stageUtils';
import { RailChips } from './TaskRowList';
import { ManuscriptRowBadge } from './ManuscriptRowBadge';
import { formatTaskMessage } from './taskMessages';
import { ROW_TONE_BAR, ROW_TONE_BORDER, getRowTone } from './rowTone';
import { TaskFileName } from './TaskFileName';

interface TaskGridListProps {
  files: any[];
  typeDef: TaskTypeDef;
  formData: any;
  taskStatus: string;
  manuscriptPool?: any[];
  onProofread: (file: any) => void;
  onDelete: (uuid: string) => void;
  onRetry: (file: any) => void;
  onReleaseGate?: (file: any, gate: 'subtitle' | 'dubbing') => void;
  onInspectDubbing?: (file: any) => void;
  onAssignManuscript?: (
    file: any,
    manuscriptPath: string,
    manuscriptName?: string,
  ) => void;
  onImport?: () => void;
}

// 仅在卡片进入视口时挂载 <video>，限制同时存在的解码器数量
function useInView<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);
  return { ref, inView };
}

function Cover({ file }: { file: any }) {
  const filePath = file?.filePath || '';
  const isSub = isSubtitleFile(filePath);
  const isAudio = isAudioPath(filePath);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const { ref, inView } = useInView<HTMLDivElement>();

  let Icon = Clapperboard;
  if (isSub) Icon = FileText;
  else if (isAudio) Icon = Music;

  // 仅视频且未解码失败时用 <video> 静态封面；其余/失败用类型大图标
  const showVideo = !isSub && !isAudio && !decodeFailed;

  return (
    <div
      ref={ref}
      className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-md bg-muted"
    >
      {showVideo && inView ? (
        <video
          src={`media://${encodeURIComponent(filePath)}`}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
          onError={() => setDecodeFailed(true)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            // 部分容器（mkv/ts/hevc 等）Chromium 解不出画面：videoWidth=0 → 退回图标
            if ((v.videoWidth || 0) === 0) {
              setDecodeFailed(true);
              return;
            }
            // preload=metadata 下仅靠 #t= 片段不一定绘制首帧（画面空白），
            // 主动 seek 触发解码并绘制：取 1s 处，短片回退到中点。
            try {
              v.currentTime =
                v.duration && v.duration < 1.5 ? v.duration / 2 : 1;
            } catch {
              // seek 失败：保持元素，真正解码失败由 onError 兜底退回图标
            }
          }}
        />
      ) : (
        <Icon className="h-10 w-10 text-muted-foreground/50" />
      )}
    </div>
  );
}

const TaskGridList: React.FC<TaskGridListProps> = ({
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
    // 空态：统一三步引导（与列表视图 TaskRowList 同形态）
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
    // 按最小卡片宽度自动分列，而不是按窗口断点：1024 宽时不会挤成 220px 的窄卡
    <div
      data-testid="task-grid"
      className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3"
    >
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
        const tone = getRowTone(status.state, failed, Boolean(displayWarning));
        const started = stages.some(
          (s) => getStageStatus(file, s.key) !== 'pending',
        );
        const meta = [
          formatBytes(file?.fileSize),
          formatMediaDuration(file?.duration),
        ]
          .filter(Boolean)
          .join(' · ');
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
            data-testid="task-card"
            data-tone={tone}
            data-state={status.state}
            className={cn(
              'group relative flex flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/40',
              ROW_TONE_BORDER[tone],
            )}
          >
            <div className="relative">
              <Cover file={file} />
              {file?.embeddedSubtitle && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="absolute left-1 top-1 inline-flex items-center rounded bg-background/80 p-0.5 text-primary backdrop-blur">
                        <Captions className="h-3.5 w-3.5" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs">
                      {t('row.embeddedSubtitle')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <button
                type="button"
                aria-label={t('row.remove')}
                className="absolute right-1 top-1 rounded bg-background/80 p-0.5 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-0"
                disabled={queueBusy}
                onClick={() => onDelete(file?.uuid)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* 正文列比封面内缩 6px：进度文字、状态箭头、操作图标共用同一条右边线 */}
            <div
              data-testid="task-card-body"
              className="flex min-w-0 flex-1 flex-col gap-2 px-1.5"
            >
              <TaskFileName file={file} className="text-xs font-medium" />

              {/* 固定高度：「+ 参考文稿」悬停时只淡入，卡片高度不随悬停变化 */}
              <div
                data-testid="task-card-meta"
                className="flex h-6 min-w-0 items-center gap-2"
              >
                {meta && (
                  <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
                    {meta}
                  </span>
                )}
                {typeDef?.needsModel && (
                  <div className="ml-auto flex min-w-0 justify-end">
                    <ManuscriptRowBadge
                      file={file}
                      formData={formData}
                      disabled={queueBusy}
                      compact
                      manuscriptPool={manuscriptPool}
                      onAssignManuscript={onAssignManuscript}
                    />
                  </div>
                )}
              </div>

              <RailChips file={file} rail={rail} t={t} className="flex-wrap" />

              <div className="flex items-center gap-2">
                <Progress
                  value={percent}
                  className="h-1.5"
                  indicatorClassName={ROW_TONE_BAR[tone]}
                />
                <span
                  data-testid="task-progress-label"
                  className="w-[34px] text-right text-[11px] tabular-nums text-muted-foreground"
                >
                  {started ? `${percent}%` : '--'}
                </span>
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

              {/* -mr-1.5：图标按钮自带内边距，抵消后图标线条与上方文字右对齐；窄卡时折行而不溢出 */}
              <div
                data-testid="task-actions"
                className="-mr-1.5 mt-auto flex flex-wrap items-center justify-end gap-1"
              >
                {dockedGate && (
                  <>
                    {dockedGate.key === 'subtitleGate' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-xs border-warning/50 text-warning hover:text-warning"
                        onClick={() => onProofread(file)}
                      >
                        <Edit2 className="h-3 w-3" />
                        {t('gate.review')}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-xs border-warning/50 text-warning hover:text-warning"
                        onClick={() => onInspectDubbing?.(file)}
                      >
                        <AudioLines className="h-3 w-3" />
                        {t('gate.inspectDubbing')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="h-7 gap-1 text-xs"
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
                    className="h-7 gap-1 text-xs"
                    disabled={queueBusy}
                    onClick={() => onRetry(file)}
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t('row.retry')}
                  </Button>
                )}
                {/* 字幕检查点的「校对」按钮就是同一个动作，不再并排放第二个铅笔图标 */}
                {dockedGate?.key !== 'subtitleGate' && (
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
                )}
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
          </div>
        );
      })}
    </div>
  );
};

export default TaskGridList;

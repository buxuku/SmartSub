import React, { useEffect, useRef, useState } from 'react';
import {
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
import { cn, isSubtitleFile, isAudioPath } from 'lib/utils';
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

interface TaskGridListProps {
  files: any[];
  typeDef: TaskTypeDef;
  formData: any;
  taskStatus: string;
  onProofread: (file: any) => void;
  onDelete: (uuid: string) => void;
  onRetry: (file: any) => void;
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
  onProofread,
  onDelete,
  onRetry,
}) => {
  const { t } = useTranslation('tasks');
  const queueBusy =
    taskStatus === 'running' ||
    taskStatus === 'paused' ||
    taskStatus === 'cancelling';

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
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {files.map((file) => {
        const stages: StageDef[] = getFileStages(file, typeDef, formData);
        const percent = getFilePercent(file, stages);
        const failed = hasFileError(file, stages);
        const rawError = failed ? getFileError(file, stages) : '';
        const errorMsg =
          rawError === 'TASK_INTERRUPTED' ? t('interrupted') : rawError;
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
              'group relative flex flex-col gap-2 rounded-lg border p-2 transition-colors hover:bg-muted/40',
              failed && 'border-destructive/30',
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
                className="absolute right-1 top-1 rounded bg-background/80 p-0.5 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-destructive group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                disabled={queueBusy}
                onClick={() => onDelete(file?.uuid)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default truncate text-xs font-medium">
                    {file?.fileName}
                    {file?.fileExtension}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-md">
                  <p className="break-all">{file?.filePath}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {meta && (
              <span className="text-[11px] text-muted-foreground">{meta}</span>
            )}

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {stages.map((stage) => {
                const status = getStageStatus(file, stage.key);
                return (
                  <span
                    key={stage.key}
                    className={cn(
                      'inline-flex items-center gap-1 text-[11px] whitespace-nowrap',
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
                  </span>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <Progress value={percent} className="h-1.5" />
              <span className="w-[34px] text-right text-[11px] tabular-nums text-muted-foreground">
                {started ? `${percent}%` : '--'}
              </span>
            </div>

            {failed && errorMsg && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="cursor-default truncate text-xs text-destructive">
                      {errorMsg}
                    </p>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-md">
                    <p className="break-all">{errorMsg}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            <div className="mt-auto flex items-center justify-end gap-1">
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
        );
      })}
    </div>
  );
};

export default TaskGridList;

import React from 'react';
import { useRouter } from 'next/router';
import {
  CheckCircle2,
  ChevronDown,
  Edit2,
  Film,
  FolderOpen,
  Home,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTranslation } from 'next-i18next';
import {
  getFileStages,
  isFileTerminal,
  isFileDone,
  getRevealPath,
  canProofreadFile,
  getProofreadUnavailableReason,
} from './stageUtils';

interface CompletionBannerProps {
  files: any[];
  typeDef: TaskTypeDef;
  formData: any;
  taskStatus: string;
  dismissed: boolean;
  /** 引导示例工程完成时给「下一步去哪」的额外指引 */
  projectId?: string | null;
  onDismiss: () => void;
  onProofread: (file: any) => void;
  onRetryFailed: (files: any[]) => void;
}

const CompletionBanner: React.FC<CompletionBannerProps> = ({
  files,
  typeDef,
  formData,
  taskStatus,
  dismissed,
  projectId,
  onDismiss,
  onProofread,
  onRetryFailed,
}) => {
  const { t } = useTranslation('tasks');
  const router = useRouter();
  const { locale } = router.query;

  if (
    dismissed ||
    !files.length ||
    taskStatus === 'running' ||
    taskStatus === 'cancelling' ||
    taskStatus === 'cancelled'
  )
    return null;

  const withStages = files.map((file) => ({
    file,
    stages: getFileStages(file, typeDef, formData),
  }));

  const allTerminal = withStages.every(({ file, stages }) =>
    isFileTerminal(file, stages),
  );
  if (!allTerminal) return null;

  const doneFiles = withStages
    .filter(({ file, stages }) => isFileDone(file, stages))
    .map(({ file }) => file);
  const failedFiles = withStages
    .filter(({ file, stages }) => !isFileDone(file, stages))
    .map(({ file }) => file);

  if (!doneFiles.length && !failedFiles.length) return null;

  const firstDone = doneFiles[0];
  const multiDone = doneFiles.length > 1;
  const isSample = projectId === 'sample-onboarding';
  const hasProofreadableFile = doneFiles.some((file) =>
    canProofreadFile(file, typeDef),
  );
  const firstProofreadUnavailableReason = getProofreadUnavailableReason(
    firstDone,
    typeDef,
  );
  const proofreadDisabledTooltip =
    firstProofreadUnavailableReason === 'txt' || !hasProofreadableFile
      ? t('row.proofreadTxtUnsupported')
      : t('completion.goProofread');

  const handleOpenFolder = () => {
    const filePath = getRevealPath(firstDone);
    if (filePath) {
      window?.ipc?.invoke('subtitleMerge:openOutputFolder', { filePath });
    }
  };

  const getMergeSubtitle = (file: any): string =>
    file?.translatedSrtFile || file?.srtFile || '';

  const mergeableFiles =
    typeDef.accepts === 'media'
      ? doneFiles.filter((file) => Boolean(getMergeSubtitle(file)))
      : [];

  const handleGoMerge = (file: any) => {
    router.push(
      `/${locale}/subtitleMerge?video=${encodeURIComponent(
        file.filePath,
      )}&subtitle=${encodeURIComponent(getMergeSubtitle(file))}`,
    );
  };

  const fileLabel = (file: any) =>
    `${file?.fileName ?? ''}${file?.fileExtension ?? ''}`;

  if (!doneFiles.length && failedFiles.length > 0) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-center gap-3 flex-wrap">
        <RotateCcw className="h-5 w-5 text-destructive flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-destructive">
            {t('completion.allFailedTitle', { failed: failedFiles.length })}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => onRetryFailed(failedFiles)}
          >
            <RotateCcw className="h-3 w-3" />
            {t('completion.retryFailed')}
          </Button>
          <button
            type="button"
            aria-label={t('completion.dismiss')}
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={onDismiss}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  if (!doneFiles.length) return null;

  return (
    <div className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 flex items-center gap-3 flex-wrap">
      <CheckCircle2 className="h-5 w-5 text-success flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">
          {isSample
            ? t('completion.sampleTitle')
            : t('completion.title', { done: doneFiles.length })}
        </span>
        {isSample && (
          <span className="text-sm text-muted-foreground ml-2">
            {t('completion.sampleHint')}
          </span>
        )}
        {failedFiles.length > 0 && (
          <span className="text-sm text-destructive ml-2">
            {t('completion.failed', { failed: failedFiles.length })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {multiDone && hasProofreadableFile ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                <Edit2 className="h-3 w-3" />
                {t('completion.goProofread')}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-[320px]">
              {doneFiles.map((file) => {
                const unavailableReason = getProofreadUnavailableReason(
                  file,
                  typeDef,
                );
                return (
                  <DropdownMenuItem
                    key={file.uuid}
                    className="text-xs"
                    disabled={unavailableReason !== null}
                    onClick={() => onProofread(file)}
                  >
                    <span className="truncate">{fileLabel(file)}</span>
                    {unavailableReason === 'txt' && (
                      <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                        {t('row.proofreadTxtUnsupportedShort')}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : multiDone ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    disabled
                  >
                    <Edit2 className="h-3 w-3" />
                    {t('completion.goProofread')}
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px]">
                {proofreadDisabledTooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    disabled={!canProofreadFile(firstDone, typeDef)}
                    onClick={() => onProofread(firstDone)}
                  >
                    <Edit2 className="h-3 w-3" />
                    {t('completion.goProofread')}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px]">
                {canProofreadFile(firstDone, typeDef)
                  ? t('completion.goProofread')
                  : proofreadDisabledTooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {mergeableFiles.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                <Film className="h-3 w-3" />
                {t('completion.goMerge')}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-[320px]">
              {mergeableFiles.map((file) => (
                <DropdownMenuItem
                  key={file.uuid}
                  className="text-xs"
                  onClick={() => handleGoMerge(file)}
                >
                  <span className="truncate">{fileLabel(file)}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          mergeableFiles.length === 1 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => handleGoMerge(mergeableFiles[0])}
            >
              <Film className="h-3 w-3" />
              {t('completion.goMerge')}
            </Button>
          )
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={handleOpenFolder}
        >
          <FolderOpen className="h-3 w-3" />
          {t('completion.openFolder')}
        </Button>
        {failedFiles.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => onRetryFailed(failedFiles)}
          >
            <RotateCcw className="h-3 w-3" />
            {t('completion.retryFailed')}
          </Button>
        )}
        {isSample && (
          <Button
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => router.push(`/${locale}/home`)}
          >
            <Home className="h-3 w-3" />
            {t('completion.backHome')}
          </Button>
        )}
        <button
          type="button"
          aria-label={t('completion.dismiss')}
          className="text-muted-foreground hover:text-foreground transition-colors"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default CompletionBanner;

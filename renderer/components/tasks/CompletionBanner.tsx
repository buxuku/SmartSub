import React from 'react';
import { useRouter } from 'next/router';
import {
  CheckCircle2,
  ChevronDown,
  Edit2,
  Film,
  FolderOpen,
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
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTranslation } from 'next-i18next';
import {
  getFileStages,
  isFileTerminal,
  isFileDone,
  getRevealPath,
} from './stageUtils';

interface CompletionBannerProps {
  files: any[];
  typeDef: TaskTypeDef;
  formData: any;
  taskStatus: string;
  dismissed: boolean;
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

  if (!doneFiles.length) return null;

  const firstDone = doneFiles[0];
  const multiDone = doneFiles.length > 1;

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

  return (
    <div className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 flex items-center gap-3 flex-wrap">
      <CheckCircle2 className="h-5 w-5 text-success flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">
          {t('completion.title', { done: doneFiles.length })}
        </span>
        {failedFiles.length > 0 && (
          <span className="text-sm text-destructive ml-2">
            {t('completion.failed', { failed: failedFiles.length })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {multiDone ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                <Edit2 className="h-3 w-3" />
                {t('completion.goProofread')}
                <ChevronDown className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-[320px]">
              {doneFiles.map((file) => (
                <DropdownMenuItem
                  key={file.uuid}
                  className="text-xs"
                  onClick={() => onProofread(file)}
                >
                  <span className="truncate">{fileLabel(file)}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => onProofread(firstDone)}
          >
            <Edit2 className="h-3 w-3" />
            {t('completion.goProofread')}
          </Button>
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

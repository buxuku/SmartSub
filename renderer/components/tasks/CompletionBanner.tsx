import React from 'react';
import { useRouter } from 'next/router';
import {
  CheckCircle2,
  Edit2,
  Film,
  FolderOpen,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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

  const handleOpenFolder = () => {
    const filePath = getRevealPath(firstDone);
    if (filePath) {
      window?.ipc?.invoke('subtitleMerge:openOutputFolder', { filePath });
    }
  };

  const mergeSubtitle =
    firstDone?.translatedSrtFile || firstDone?.srtFile || '';
  const canMerge = typeDef.accepts === 'media' && Boolean(mergeSubtitle);

  const handleGoMerge = () => {
    router.push(
      `/${locale}/subtitleMerge?video=${encodeURIComponent(
        firstDone.filePath,
      )}&subtitle=${encodeURIComponent(mergeSubtitle)}`,
    );
  };

  return (
    <div className="rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3 flex items-center gap-3 flex-wrap">
      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">
          {t('completion.title', { done: doneFiles.length })}
        </span>
        {failedFiles.length > 0 && (
          <span className="text-sm text-red-500 ml-2">
            {t('completion.failed', { failed: failedFiles.length })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={() => onProofread(firstDone)}
        >
          <Edit2 className="h-3 w-3" />
          {t('completion.goProofread')}
        </Button>
        {canMerge && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={handleGoMerge}
          >
            <Film className="h-3 w-3" />
            {t('completion.goMerge')}
          </Button>
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

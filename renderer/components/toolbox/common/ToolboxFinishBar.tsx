import React from 'react';
import { useRouter } from 'next/router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  CheckCircle2,
  FolderOpen,
  Captions,
  Mic2,
  FileCheck2,
  Film,
  RotateCcw,
} from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { cn } from 'lib/utils';
import { WIZARD_DROP_KEY } from '@/lib/recipes';
import { toast } from 'sonner';

export interface ToolboxFinishBarProps {
  outputPath?: string;
  outputPaths?: string[];
  outputType?: 'video' | 'audio' | 'subtitle' | 'gif' | 'generic';
  summary?: string;
  stats?: {
    originalSize?: number;
    compressedSize?: number;
    savedPercent?: number;
  };
  onReset?: () => void;
  className?: string;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export default function ToolboxFinishBar({
  outputPath,
  outputPaths,
  outputType = 'generic',
  summary,
  stats,
  onReset,
  className,
}: ToolboxFinishBarProps) {
  const router = useRouter();
  const locale =
    typeof router.query.locale === 'string' ? router.query.locale : 'zh';
  const { t } = useTranslation('toolbox');

  const primaryPath = outputPath || outputPaths?.[0] || '';
  const allPaths = Array.from(
    new Set([...(outputPaths || []), ...(outputPath ? [outputPath] : [])]),
  );
  if (!primaryPath && !outputPaths?.length) return null;

  const handleOpenFolder = () => {
    if (primaryPath && window?.ipc?.invoke) {
      window.ipc.invoke('toolbox:openFolder', primaryPath);
    }
  };

  const handoff = async (goals: 'translate' | 'dub') => {
    try {
      const files = await window.ipc.invoke('getDroppedFiles', {
        files: allPaths,
        taskType: outputType === 'subtitle' ? 'translate' : 'media',
      });
      if (!Array.isArray(files) || !files.length)
        throw new Error(t('finishBar.importFailed'));
      sessionStorage.setItem(WIZARD_DROP_KEY, JSON.stringify(files));
      await router.push(`/${locale}/tasks/new?goals=${goals}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  const handleGoToSubtitle = () => void handoff('translate');
  const handleGoToDubbing = () => void handoff('dub');

  const handleGoToProofread = () => {
    void router.push({
      pathname: `/${locale}/proofread`,
      query: { file: allPaths },
    });
  };

  const handleGoToBurn = (filePath: string) => {
    router.push(
      `/${locale}/subtitleMerge?subtitle=${encodeURIComponent(filePath)}`,
    );
  };

  let statsText = '';
  if (stats?.originalSize && stats?.compressedSize) {
    const saved =
      Math.round(
        ((stats.originalSize - stats.compressedSize) / stats.originalSize) *
          1000,
      ) / 10;
    statsText = t(
      saved < 0
        ? 'finishBar.statsIncreased'
        : saved === 0
          ? 'finishBar.statsUnchanged'
          : 'finishBar.stats',
      {
        original: formatBytes(stats.originalSize),
        compressed: formatBytes(stats.compressedSize),
        saved: Math.abs(saved),
      },
    );
  }

  return (
    <div
      className={cn(
        'min-w-0 bg-green-500/5 p-3 space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-200',
        className,
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
            <h4 className="break-words text-xs font-semibold text-green-800 dark:text-green-300">
              {summary || t('finishBar.title')}
            </h4>
          </div>
          {statsText && (
            <p className="text-xs font-medium text-green-700/80 dark:text-green-400/80 pl-7">
              {statsText}
            </p>
          )}
          <p
            className="text-xs text-muted-foreground truncate pl-7"
            title={primaryPath}
          >
            {t('finishBar.savedTo', { path: primaryPath })}
          </p>
        </div>

        {onReset && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            title={t('finishBar.processNext')}
            aria-label={t('finishBar.processNext')}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground shrink-0"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-green-500/10">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleOpenFolder}
          className="h-8 text-xs gap-1.5"
        >
          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
          {t('finishBar.openFolder')}
        </Button>

        {(outputType === 'video' || outputType === 'audio') && (
          <>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleGoToSubtitle}
              className="h-8 text-xs gap-1.5 bg-green-600 hover:bg-green-700 text-white"
            >
              <Captions className="h-3.5 w-3.5" />
              {t('finishBar.goToSubtitle')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGoToDubbing}
              className="h-8 text-xs gap-1.5"
            >
              <Mic2 className="h-3.5 w-3.5 text-muted-foreground" />
              {t('finishBar.goToDubbing')}
            </Button>
          </>
        )}

        {outputType === 'subtitle' && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGoToDubbing}
              className="h-8 text-xs gap-1.5"
            >
              <Mic2 className="h-3.5 w-3.5" />
              {t('finishBar.goToDubbing')}
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleGoToProofread}
              className="h-8 text-xs gap-1.5 bg-green-600 hover:bg-green-700 text-white"
            >
              <FileCheck2 className="h-3.5 w-3.5" />
              {t('finishBar.goToProofread')}
            </Button>
            {allPaths.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs gap-1.5"
                  >
                    <Film className="h-3.5 w-3.5 text-muted-foreground" />
                    {t('finishBar.goToBurn')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-64 max-w-sm overflow-y-auto">
                  {allPaths.map((filePath) => (
                    <DropdownMenuItem
                      key={filePath}
                      onSelect={() => handleGoToBurn(filePath)}
                      title={filePath}
                    >
                      <span className="truncate">
                        {filePath.split(/[/\\]/).pop()}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleGoToBurn(primaryPath)}
                className="h-8 text-xs gap-1.5"
              >
                <Film className="h-3.5 w-3.5 text-muted-foreground" />
                {t('finishBar.goToBurn')}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import { CheckCircle2, CloudDownload, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { readPersistedDownloadSource } from '@/components/settings/gpu/gpuDownloadUtils';
import type {
  DownloaderEngine,
  DownloaderInstallProgress,
  DownloaderStatus,
} from '../../../types/download';

const ENGINE_LABELS: Record<DownloaderEngine, string> = {
  'yt-dlp': 'yt-dlp',
  lux: 'lux',
};

const ENGINE_HINTS: Record<DownloaderEngine, string> = {
  'yt-dlp': 'YouTube / 1800+ sites',
  lux: 'Bilibili / 抖音 / 小红书…',
};

/**
 * 下载引擎安装/更新卡：未安装任何引擎时作为下载页的引导主体，
 * 已安装时折叠为状态行（版本 + 更新提示）。
 */
export default function EngineSetupCard({
  statuses,
  onStatusesChange,
}: {
  statuses: DownloaderStatus[] | null;
  onStatusesChange: () => void;
}) {
  const { t } = useTranslation('download');
  const [installing, setInstalling] = useState<
    Partial<Record<DownloaderEngine, DownloaderInstallProgress>>
  >({});
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const cleanup = window?.ipc?.on(
      'videoDownload:installProgress',
      (p: DownloaderInstallProgress) => {
        setInstalling((prev) => ({ ...prev, [p.engine]: p }));
        if (p.phase === 'completed' || p.phase === 'error') {
          setTimeout(() => {
            setInstalling((prev) => {
              const next = { ...prev };
              delete next[p.engine];
              return next;
            });
            onStatusesChange();
          }, 600);
        }
      },
    );
    return () => cleanup?.();
  }, [onStatusesChange]);

  const install = useCallback(
    async (engine: DownloaderEngine) => {
      setInstalling((prev) => ({
        ...prev,
        [engine]: { engine, phase: 'downloading', progress: 0 },
      }));
      try {
        await window?.ipc?.invoke('videoDownload:install', {
          engine,
          source: readPersistedDownloadSource(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('BUSY_DOWNLOADING')) {
          toast.warning(t('setup.busyDownloading'));
        } else {
          toast.error(
            t('setup.installFailed', { error: message.slice(0, 200) }),
          );
        }
        setInstalling((prev) => {
          const next = { ...prev };
          delete next[engine];
          return next;
        });
      }
    },
    [t],
  );

  const checkUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const next: DownloaderStatus[] = await window?.ipc?.invoke(
        'videoDownload:checkUpdates',
        { source: readPersistedDownloadSource() },
      );
      onStatusesChange();
      if (next?.every((s) => !s.hasUpdate)) {
        toast.success(t('setup.upToDate'));
      }
    } finally {
      setChecking(false);
    }
  }, [onStatusesChange, t]);

  if (!statuses) return null;
  const anyInstalled = statuses.some((s) => s.installed);

  const renderEngineRow = (status: DownloaderStatus) => {
    const progress = installing[status.engine];
    const busy = Boolean(progress);
    return (
      <div
        key={status.engine}
        className="flex items-center gap-3 rounded-md border bg-background/60 px-3 py-2"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {ENGINE_LABELS[status.engine]}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {ENGINE_HINTS[status.engine]}
            </span>
          </div>
          {busy ? (
            <div className="mt-1.5 flex items-center gap-2">
              <Progress value={progress!.progress} className="h-1 flex-1" />
              <span className="flex-shrink-0 font-mono text-[11px] text-muted-foreground">
                {progress!.phase === 'verifying'
                  ? t('setup.verifying')
                  : `${Math.round(progress!.progress)}%`}
              </span>
            </div>
          ) : (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {status.installed
                ? t('setup.installed', { version: status.installed.version })
                : t('setup.notInstalled')}
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {status.installed && !status.hasUpdate && !busy && (
            <CheckCircle2 className="h-4 w-4 text-success" />
          )}
          {!busy && !status.installed && (
            <Button
              size="sm"
              className="h-7"
              onClick={() => install(status.engine)}
            >
              <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
              {t('setup.install')}
            </Button>
          )}
          {!busy && status.installed && status.hasUpdate && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => install(status.engine)}
            >
              <CloudDownload className="mr-1.5 h-3.5 w-3.5" />
              {t('setup.updateTo', { version: status.latestVersion })}
            </Button>
          )}
          {busy && (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>
    );
  };

  return (
    <Panel className="flex-none p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {anyInstalled ? t('setup.engineStatus') : t('setup.title')}
          </span>
          {statuses.some((s) => s.hasUpdate) && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {t('setup.checkUpdates')}
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-muted-foreground"
          disabled={checking}
          onClick={checkUpdates}
        >
          {checking ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          {checking ? t('setup.checking') : t('setup.checkUpdates')}
        </Button>
      </div>
      {!anyInstalled && (
        <p className="mb-2.5 text-xs leading-relaxed text-muted-foreground">
          {t('setup.desc')}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {statuses.map(renderEngineRow)}
      </div>
    </Panel>
  );
}

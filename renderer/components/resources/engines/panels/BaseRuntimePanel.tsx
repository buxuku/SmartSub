import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { RefreshCw, ArrowUpCircle, X, Download } from 'lucide-react';
import { toast } from 'sonner';
import { persistDownloadSource } from '@/components/settings/gpu/gpuDownloadUtils';
import { formatSize } from '@/components/settings/gpu/gpuUtils';
import type { DownloadSource } from '../../../../../types/addon';
import type {
  PyBaseDownloadProgress,
  PyBaseStatus,
  PyBaseUpdateInfo,
} from '../../../../../types/engine';

interface BaseRuntimePanelProps {
  taskBusy: boolean;
  defaultSource: DownloadSource;
}

const BaseRuntimePanel: React.FC<BaseRuntimePanelProps> = ({
  taskBusy,
  defaultSource,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [status, setStatus] = useState<PyBaseStatus | null>(null);
  const [progress, setProgress] = useState<PyBaseDownloadProgress | null>(null);
  const [updateInfo, setUpdateInfo] = useState<PyBaseUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [source, setSource] = useState<DownloadSource>(defaultSource);

  const loadStatus = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('get-py-base-status');
      if (r) setStatus(r as PyBaseStatus);
    } catch {
      // 忽略：保持上次状态
    }
  }, []);

  useEffect(() => {
    loadStatus();
    (async () => {
      try {
        const p = await window?.ipc?.invoke('get-py-base-download-progress');
        if (p) setProgress(p);
      } catch {
        // 忽略
      }
    })();

    const unsubProgress = window?.ipc?.on(
      'py-base-download-progress',
      (p: PyBaseDownloadProgress) => {
        setProgress(p);
        if (p.status === 'completed') {
          setUpdateInfo(null);
          loadStatus();
        } else if (p.status === 'error') {
          loadStatus();
        }
      },
    );

    const unsubUpdate = window?.ipc?.on(
      'py-base-update-available',
      (info: PyBaseUpdateInfo) => setUpdateInfo(info),
    );

    return () => {
      unsubProgress?.();
      unsubUpdate?.();
    };
  }, [loadStatus]);

  const ready = status?.state === 'ready';
  const baseSource = status?.source ?? 'none';
  const isDownloading =
    progress?.status === 'downloading' || progress?.status === 'extracting';
  const showVerifying = progress?.status === 'verifying';
  const hasUpdate = !!updateInfo?.hasUpdate;

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const r = await window?.ipc?.invoke('check-py-base-update', { source });
      if (!r?.success) {
        toast.error(t('engines.base.checkFailed'));
        return;
      }
      const info = r.info as PyBaseUpdateInfo;
      setUpdateInfo(info);
      if (info.hasUpdate) {
        toast.success(t('engines.base.updateAvailable'));
      } else {
        toast.success(t('engines.base.upToDate'));
      }
    } catch {
      toast.error(t('engines.base.checkFailed'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleUpgrade = async () => {
    setShowUpgradeConfirm(false);
    persistDownloadSource(source);
    const r = await window?.ipc?.invoke('start-py-base-download', { source });
    if (!r?.success) {
      toast.error(
        r?.error === 'engine_busy'
          ? t('engines.base.engineBusy')
          : r?.error || 'Failed to start base upgrade',
      );
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancel-py-base-download');
  };

  const badge = (() => {
    if (isDownloading) {
      return <Badge variant="secondary">{t('engines.base.downloading')}</Badge>;
    }
    if (showVerifying) {
      return <Badge variant="secondary">{t('engines.base.verifying')}</Badge>;
    }
    if (ready) {
      return (
        <Badge variant="outline" className="border-success/40 text-success">
          {baseSource === 'downloaded'
            ? t('engines.base.downloaded')
            : t('engines.base.builtin')}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t('engines.base.notReady')}
      </Badge>
    );
  })();

  const sourceSelector = (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {t('engines.base.downloadSource')}
      </p>
      <div className="flex gap-2">
        {(['github', 'ghproxy', 'gitcode'] as DownloadSource[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSource(s)}
            className={`flex-1 px-3 py-2 rounded-md border text-xs transition-all ${
              source === s
                ? 'border-primary bg-primary/5 font-medium'
                : 'border-muted hover:border-primary/50'
            }`}
          >
            {s === 'github'
              ? 'GitHub'
              : s === 'gitcode'
                ? 'GitCode'
                : t('ghProxy')}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-muted-foreground">
            {t('engines.base.desc')}
          </p>
          <div className="shrink-0">{badge}</div>
        </div>

        {isDownloading && progress && (
          <div className="space-y-2 rounded-lg bg-muted p-3">
            <p className="text-sm font-medium">
              {t('engines.base.downloading')}
            </p>
            <Progress value={progress.progress} />
            {progress.total > 0 && (
              <p className="text-xs text-muted-foreground">
                {formatSize(progress.downloaded)} / {formatSize(progress.total)}
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              onClick={handleCancel}
            >
              <X className="h-3.5 w-3.5" />
              {commonT('cancel')}
            </Button>
          </div>
        )}

        {showVerifying && !isDownloading && (
          <div className="rounded-lg bg-muted p-3">
            <p className="text-sm font-medium">{t('engines.base.verifying')}</p>
          </div>
        )}

        {ready && !isDownloading && !showVerifying && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {hasUpdate ? (
              <>
                <Badge
                  variant="outline"
                  className="border-primary/40 text-primary"
                >
                  {t('engines.base.updateAvailable')}
                </Badge>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={taskBusy}
                  onClick={() => setShowUpgradeConfirm(true)}
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  {t('engines.base.upgrade')}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={checkingUpdate}
                onClick={handleCheckUpdate}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${checkingUpdate ? 'animate-spin' : ''}`}
                />
                {checkingUpdate
                  ? t('engines.base.checking')
                  : t('engines.base.checkUpdate')}
              </Button>
            )}
          </div>
        )}
      </div>

      <AlertDialog
        open={showUpgradeConfirm}
        onOpenChange={setShowUpgradeConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('engines.base.upgrade')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.base.upgradeConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {sourceSelector}
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction className="gap-1.5" onClick={handleUpgrade}>
              <Download className="h-4 w-4" />
              {t('engines.base.upgrade')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default BaseRuntimePanel;

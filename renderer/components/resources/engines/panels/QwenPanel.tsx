import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import {
  ArrowUpCircle,
  Download,
  Info,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import { persistDownloadSource } from '@/components/settings/gpu/gpuDownloadUtils';
import type { DownloadSource } from '../../../../../types/addon';
import type { EngineStatus } from '../../../../../types/engine';
import type { SherpaLibStatus } from '../../../../../types/sherpa';

// 与 FunASR 共用同一 sherpa-onnx 原生运行库，体积取约值用于提示。
const QWEN_RUNTIME_SIZE = '20MB';

interface QwenPanelProps {
  status?: EngineStatus;
  taskBusy: boolean;
  defaultSource: DownloadSource;
  onRefreshStatuses: () => void | Promise<void>;
}

const QwenPanel: React.FC<QwenPanelProps> = ({
  status,
  taskBusy,
  defaultSource,
  onRefreshStatuses,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [libStatus, setLibStatus] = useState<SherpaLibStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [source, setSource] = useState<DownloadSource>(defaultSource);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [numThreads, setNumThreads] = useState(2);

  const loadLibStatus = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('sherpa-lib-status');
      if (r) setLibStatus(r as SherpaLibStatus);
    } catch {
      // 忽略：保持上次状态
    }
  }, []);

  useEffect(() => {
    loadLibStatus();
    (async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        if (settings && typeof settings.qwenNumThreads === 'number') {
          setNumThreads(settings.qwenNumThreads);
        }
      } catch {
        // 忽略
      }
    })();

    const unsub = window?.ipc?.on(
      'sherpa-lib-download-progress',
      (p: { progress: number }) => {
        if (typeof p?.progress === 'number') setProgress(p.progress);
      },
    );

    return () => {
      unsub?.();
    };
  }, [loadLibStatus]);

  const installed = libStatus?.installed === true;

  const handleStartDownload = async () => {
    setShowDownloadConfirm(false);
    persistDownloadSource(source);
    setDownloading(true);
    setProgress(0);
    try {
      const r = await window?.ipc?.invoke('download-sherpa-lib', { source });
      if (!r?.success) {
        toast.error(
          r?.error === 'engine_busy'
            ? t('engines.qwen.engineBusy')
            : r?.error || 'Failed to download runtime',
        );
        return;
      }
      setHasUpdate(false);
      await loadLibStatus();
      await onRefreshStatuses();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloading(false);
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const r = await window?.ipc?.invoke('check-sherpa-lib-update');
      if (!r?.success) {
        toast.error(t('engines.qwen.checkFailed'));
        return;
      }
      setHasUpdate(!!r.hasUpdate);
      toast.success(
        r.hasUpdate
          ? t('engines.qwen.updateAvailable')
          : t('engines.qwen.upToDate'),
      );
    } catch {
      toast.error(t('engines.qwen.checkFailed'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleUninstall = async () => {
    setShowUninstallConfirm(false);
    const r = await window?.ipc?.invoke('remove-sherpa-lib');
    if (r?.success) {
      setHasUpdate(false);
      await loadLibStatus();
      await onRefreshStatuses();
    } else {
      toast.error(
        r?.error === 'engine_busy'
          ? t('engines.qwen.engineBusy')
          : r?.error || 'Failed to uninstall',
      );
    }
  };

  const handleThreadsChange = async (value: string) => {
    const n = Number(value);
    setNumThreads(n);
    await window?.ipc?.invoke('set-qwen-settings', { numThreads: n });
  };

  const sourceSelector = (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {t('engines.qwen.downloadSource')}
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

  const uninstallButton = (
    <Button
      size="sm"
      variant="ghost"
      className="gap-1.5 text-muted-foreground"
      onClick={() => setShowUninstallConfirm(true)}
      disabled={taskBusy}
    >
      <Trash2 className="h-3.5 w-3.5" />
      {t('engines.qwen.uninstall')}
    </Button>
  );

  return (
    <>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t('engines.qwen.desc')}
        </p>

        <div className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('engines.qwen.desc.runtimeShared')}</span>
        </div>

        {downloading && (
          <div className="space-y-2 rounded-lg bg-muted p-3">
            <p className="text-sm font-medium">
              {t('engines.qwen.downloading')}
            </p>
            <Progress value={progress} />
            <p className="text-xs text-muted-foreground">{progress}%</p>
          </div>
        )}

        {status?.state === 'error' && status.message && (
          <p className="text-sm text-destructive">{status.message}</p>
        )}

        {!installed && !downloading && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setShowDownloadConfirm(true)}
            >
              <Download className="h-3.5 w-3.5" />
              {t('engines.qwen.downloadRuntime', { size: QWEN_RUNTIME_SIZE })}
            </Button>
          </div>
        )}

        {installed && !downloading && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {libStatus?.version && (
              <span className="text-xs text-muted-foreground">
                {t('engines.qwen.installedVersion', {
                  version: libStatus.version,
                })}
              </span>
            )}
            {hasUpdate ? (
              <>
                <Badge
                  variant="outline"
                  className="border-primary/40 text-primary"
                >
                  {t('engines.qwen.updateAvailable')}
                </Badge>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={taskBusy}
                  onClick={() => setShowDownloadConfirm(true)}
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  {t('engines.qwen.upgrade')}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={checkingUpdate || taskBusy}
                onClick={handleCheckUpdate}
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    checkingUpdate && 'animate-spin',
                  )}
                />
                {checkingUpdate
                  ? t('engines.qwen.checking')
                  : t('engines.qwen.checkUpdate')}
              </Button>
            )}
            <span className="ml-auto">{uninstallButton}</span>
          </div>
        )}

        {installed && (
          <div className="space-y-3 rounded-lg border border-muted p-3">
            <p className="text-sm font-medium">{t('engines.qwen.advanced')}</p>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t('engines.qwen.providerNote')}</span>
            </p>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label className="text-sm">
                  {t('engines.qwen.numThreads')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('engines.qwen.numThreadsHint')}
                </p>
              </div>
              <Select
                value={String(numThreads)}
                onValueChange={handleThreadsChange}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['1', '2', '4', '8'].map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>

      <AlertDialog
        open={showDownloadConfirm}
        onOpenChange={setShowDownloadConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {installed
                ? t('engines.qwen.upgrade')
                : t('engines.qwen.downloadRuntime', {
                    size: QWEN_RUNTIME_SIZE,
                  })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {installed
                ? t('engines.qwen.upgradeConfirm')
                : t('engines.qwen.downloadRuntimeConfirm', {
                    size: QWEN_RUNTIME_SIZE,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {sourceSelector}
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="gap-1.5"
              onClick={handleStartDownload}
            >
              {installed ? (
                <ArrowUpCircle className="h-4 w-4" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {installed
                ? t('engines.qwen.upgrade')
                : t('engines.qwen.downloadRuntime', {
                    size: QWEN_RUNTIME_SIZE,
                  })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showUninstallConfirm}
        onOpenChange={setShowUninstallConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('engines.qwen.uninstall')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.qwen.uninstallConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleUninstall}
            >
              <Trash2 className="h-4 w-4" />
              {t('engines.qwen.uninstall')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default QwenPanel;

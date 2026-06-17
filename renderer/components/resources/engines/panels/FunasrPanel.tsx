import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
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
import { Download, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { persistDownloadSource } from '@/components/settings/gpu/gpuDownloadUtils';
import type { DownloadSource } from '../../../../../types/addon';
import type { EngineStatus } from '../../../../../types/engine';
import type { SherpaLibStatus } from '../../../../../types/sherpa';

// sherpa-onnx 原生运行库压缩包体积（各平台略有差异，取约值用于提示）。
const FUNASR_RUNTIME_SIZE = '20MB';

interface FunasrPanelProps {
  status?: EngineStatus;
  taskBusy: boolean;
  defaultSource: DownloadSource;
  onRefreshStatuses: () => void | Promise<void>;
  onGoModels: () => void;
}

const FunasrPanel: React.FC<FunasrPanelProps> = ({
  status,
  taskBusy,
  defaultSource,
  onRefreshStatuses,
  onGoModels,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [libStatus, setLibStatus] = useState<SherpaLibStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [source, setSource] = useState<DownloadSource>(defaultSource);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [useItn, setUseItn] = useState(true);
  const [numThreads, setNumThreads] = useState(4);

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
        if (settings) {
          if (typeof settings.funasrUseItn === 'boolean')
            setUseItn(settings.funasrUseItn);
          if (typeof settings.funasrNumThreads === 'number')
            setNumThreads(settings.funasrNumThreads);
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
            ? t('engines.funasr.engineBusy')
            : r?.error || 'Failed to download runtime',
        );
        return;
      }
      await loadLibStatus();
      await onRefreshStatuses();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloading(false);
    }
  };

  const handleUninstall = async () => {
    const r = await window?.ipc?.invoke('remove-sherpa-lib');
    if (r?.success) {
      await loadLibStatus();
      await onRefreshStatuses();
    } else {
      toast.error(
        r?.error === 'engine_busy'
          ? t('engines.funasr.engineBusy')
          : r?.error || 'Failed to uninstall',
      );
    }
  };

  const handleItnChange = async (value: boolean) => {
    setUseItn(value);
    await window?.ipc?.invoke('set-funasr-settings', { useItn: value });
  };

  const handleThreadsChange = async (value: string) => {
    const n = Number(value);
    setNumThreads(n);
    await window?.ipc?.invoke('set-funasr-settings', { numThreads: n });
  };

  const sourceSelector = (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {t('engines.funasr.downloadSource')}
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
        <p className="text-sm text-muted-foreground">
          {t('engines.funasr.desc')}
        </p>

        {downloading && (
          <div className="space-y-2 rounded-lg bg-muted p-3">
            <p className="text-sm font-medium">
              {t('engines.funasr.downloading')}
            </p>
            <Progress value={progress} />
            <p className="text-xs text-muted-foreground">{progress}%</p>
          </div>
        )}

        {status?.state === 'error' && status.message && (
          <p className="text-sm text-destructive">{status.message}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!installed && !downloading && (
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setShowDownloadConfirm(true)}
            >
              <Download className="h-3.5 w-3.5" />
              {t('engines.funasr.downloadRuntime', {
                size: FUNASR_RUNTIME_SIZE,
              })}
            </Button>
          )}
          {installed && (
            <>
              {libStatus?.version && (
                <span className="text-xs text-muted-foreground">
                  {t('engines.funasr.installedVersion', {
                    version: libStatus.version,
                  })}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-muted-foreground"
                onClick={handleUninstall}
                disabled={taskBusy}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('engines.funasr.uninstall')}
              </Button>
            </>
          )}
        </div>

        {installed && (
          <div className="space-y-1.5 rounded-lg border border-muted p-3">
            <p className="text-sm font-medium">
              {t('engines.funasr.modelsTitle')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('engines.funasr.needModelsHint')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-1 gap-1.5"
              onClick={onGoModels}
            >
              <Download className="h-3.5 w-3.5" />
              {t('engines.funasr.modelsTitle')}
            </Button>
          </div>
        )}

        {installed && (
          <div className="space-y-3 rounded-lg border border-muted p-3">
            <p className="text-sm font-medium">
              {t('engines.funasr.advanced')}
            </p>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="funasr-itn" className="text-sm">
                  {t('engines.funasr.itn')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('engines.funasr.itnHint')}
                </p>
              </div>
              <Switch
                id="funasr-itn"
                checked={useItn}
                onCheckedChange={handleItnChange}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label className="text-sm">
                  {t('engines.funasr.numThreads')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('engines.funasr.numThreadsHint')}
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
              {t('engines.funasr.downloadRuntime', {
                size: FUNASR_RUNTIME_SIZE,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.funasr.downloadRuntimeConfirm', {
                size: FUNASR_RUNTIME_SIZE,
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
              <Download className="h-4 w-4" />
              {t('engines.funasr.downloadRuntime', {
                size: FUNASR_RUNTIME_SIZE,
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default FunasrPanel;

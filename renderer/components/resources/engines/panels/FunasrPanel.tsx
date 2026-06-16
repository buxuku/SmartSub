import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { Download, Trash2, RefreshCw, ArrowUpCircle, X } from 'lucide-react';
import { toast } from 'sonner';
import { persistDownloadSource } from '@/components/settings/gpu/gpuDownloadUtils';
import { formatSize } from '@/components/settings/gpu/gpuUtils';
import type { DownloadSource } from '../../../../../types/addon';
import type {
  EngineStatus,
  PyEngineDownloadProgress,
  PyEngineUpdateInfo,
} from '../../../../../types/engine';

const FUNASR_ENGINE_SIZE = '28MB';

// 仅取包/基座状态用于切换下载↔卸载 UI；模型清单已移至「模型」页统一管理。
interface FunasrPackageStatus {
  baseReady: boolean;
  engineInstalled: boolean;
  ready: boolean;
}

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

  const [pkgProgress, setPkgProgress] =
    useState<PyEngineDownloadProgress | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<PyEngineUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [pkgSource, setPkgSource] = useState<DownloadSource>(defaultSource);
  const [pkgStatus, setPkgStatus] = useState<FunasrPackageStatus | null>(null);
  const [useItn, setUseItn] = useState(true);
  const [numThreads, setNumThreads] = useState(4);

  const loadPackageStatus = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('getFunasrModelStatus');
      if (r?.success) setPkgStatus(r as FunasrPackageStatus);
    } catch {
      // 忽略：保持上次状态
    }
  }, []);

  useEffect(() => {
    loadPackageStatus();
    (async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        if (settings) {
          if (typeof settings.funasrUseItn === 'boolean')
            setUseItn(settings.funasrUseItn);
          if (typeof settings.funasrNumThreads === 'number')
            setNumThreads(settings.funasrNumThreads);
        }
        const progress = await window?.ipc?.invoke(
          'get-py-engine-download-progress',
          { engineId: 'funasr' },
        );
        if (progress) setPkgProgress(progress);
      } catch {
        // 忽略
      }
    })();

    const unsubPkg = window?.ipc?.on(
      'py-engine-download-progress',
      (p: PyEngineDownloadProgress) => {
        if (p.engineId !== 'funasr') return;
        setPkgProgress(p);
        if (p.status === 'completed') {
          setVerifying(true);
          setUpdateInfo(null);
          (async () => {
            try {
              await window?.ipc?.invoke('python-engine:ping', {
                engineId: 'funasr',
              });
            } catch {
              // 校验失败交给 refresh 反映真实状态
            } finally {
              await loadPackageStatus();
              await onRefreshStatuses();
              setVerifying(false);
            }
          })();
        } else if (p.status === 'error') {
          if (p.error === 'protocol_unsupported') {
            toast.error(t('engines.funasr.protocolUnsupported'));
          }
          onRefreshStatuses();
        }
      },
    );

    const unsubUpdate = window?.ipc?.on(
      'py-engine-update-available',
      (info: PyEngineUpdateInfo & { engineId?: string }) => {
        if (info.engineId !== 'funasr') return;
        setUpdateInfo(info);
      },
    );

    return () => {
      unsubPkg?.();
      unsubUpdate?.();
    };
  }, [loadPackageStatus, onRefreshStatuses, t]);

  const baseReady = pkgStatus?.baseReady ?? status?.state !== 'error';
  const pkgInstalled = pkgStatus?.engineInstalled ?? false;
  const isDownloadingPkg =
    pkgProgress?.status === 'downloading' ||
    pkgProgress?.status === 'extracting';
  const showVerifying = verifying || pkgProgress?.status === 'verifying';
  const hasUpdate = !!(updateInfo?.hasUpdate && updateInfo.protocolSupported);

  // 引擎包一旦确认安装/异常，立即清掉「检测中」，避免 ping 异常让标志卡死
  useEffect(() => {
    if (verifying && (pkgInstalled || status?.state === 'error')) {
      setVerifying(false);
    }
  }, [verifying, pkgInstalled, status?.state]);

  const handleStartDownload = async () => {
    setShowDownloadConfirm(false);
    persistDownloadSource(pkgSource);
    const r = await window?.ipc?.invoke('start-py-engine-download', {
      source: pkgSource,
      engineId: 'funasr',
    });
    if (!r?.success) {
      toast.error(
        r?.error === 'engine_busy'
          ? t('engines.funasr.engineBusy')
          : r?.error || 'Failed to start download',
      );
    }
  };

  const handleUpgrade = async () => {
    setShowUpgradeConfirm(false);
    persistDownloadSource(pkgSource);
    const r = await window?.ipc?.invoke('start-py-engine-download', {
      source: pkgSource,
      engineId: 'funasr',
    });
    if (!r?.success) {
      toast.error(
        r?.error === 'engine_busy'
          ? t('engines.funasr.engineBusy')
          : r?.error || 'Failed to start upgrade',
      );
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const r = await window?.ipc?.invoke('check-py-engine-update', {
        source: pkgSource,
        engineId: 'funasr',
      });
      if (!r?.success) {
        toast.error(t('engines.funasr.checkFailed'));
        return;
      }
      const info = r.info as PyEngineUpdateInfo;
      setUpdateInfo(info);
      if (!info.protocolSupported) {
        toast.error(t('engines.funasr.protocolUnsupported'));
      } else if (info.hasUpdate) {
        toast.success(t('engines.funasr.updateAvailable'));
      } else {
        toast.success(t('engines.funasr.upToDate'));
      }
    } catch {
      toast.error(t('engines.funasr.checkFailed'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleUninstall = async () => {
    const r = await window?.ipc?.invoke('uninstall-py-engine', {
      engineId: 'funasr',
    });
    if (r?.success) {
      setVerifying(false);
      await loadPackageStatus();
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
            onClick={() => setPkgSource(s)}
            className={`flex-1 px-3 py-2 rounded-md border text-xs transition-all ${
              pkgSource === s
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

        {isDownloadingPkg && pkgProgress && (
          <div className="space-y-2 rounded-lg bg-muted p-3">
            <p className="text-sm font-medium">
              {t('engines.funasr.downloading')}
            </p>
            <Progress value={pkgProgress.progress} />
            {pkgProgress.total > 0 && (
              <p className="text-xs text-muted-foreground">
                {formatSize(pkgProgress.downloaded)} /{' '}
                {formatSize(pkgProgress.total)}
              </p>
            )}
          </div>
        )}

        {showVerifying && !isDownloadingPkg && (
          <div className="rounded-lg bg-muted p-3">
            <p className="text-sm font-medium">
              {t('engines.funasr.verifying')}
            </p>
          </div>
        )}

        {!baseReady && status?.message && (
          <p className="text-sm text-destructive">{status.message}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!pkgInstalled &&
            !isDownloadingPkg &&
            !showVerifying &&
            baseReady && (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => setShowDownloadConfirm(true)}
              >
                <Download className="h-3.5 w-3.5" />
                {t('engines.funasr.download', { size: FUNASR_ENGINE_SIZE })}
              </Button>
            )}
          {pkgInstalled && (
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
          )}
        </div>

        {pkgInstalled && !isDownloadingPkg && !showVerifying && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {status?.version && (
              <span className="text-xs text-muted-foreground">
                {t('engines.funasr.installedVersion', {
                  version: status.version,
                })}
              </span>
            )}
            {hasUpdate ? (
              <>
                <Badge
                  variant="outline"
                  className="border-primary/40 text-primary"
                >
                  {t('engines.funasr.updateAvailable')}
                </Badge>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={taskBusy}
                  onClick={() => setShowUpgradeConfirm(true)}
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  {t('engines.funasr.upgrade')}
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
                  ? t('engines.funasr.checking')
                  : t('engines.funasr.checkUpdate')}
              </Button>
            )}
          </div>
        )}

        {pkgInstalled && (
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

        {pkgInstalled && (
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
              {t('engines.funasr.download', { size: FUNASR_ENGINE_SIZE })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.funasr.downloadConfirm', {
                size: FUNASR_ENGINE_SIZE,
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
              {t('engines.funasr.download', { size: FUNASR_ENGINE_SIZE })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showUpgradeConfirm}
        onOpenChange={setShowUpgradeConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('engines.funasr.upgrade')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.funasr.upgradeConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {sourceSelector}
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction className="gap-1.5" onClick={handleUpgrade}>
              <ArrowUpCircle className="h-4 w-4" />
              {t('engines.funasr.upgrade')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default FunasrPanel;

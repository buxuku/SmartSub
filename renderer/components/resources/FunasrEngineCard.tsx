import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  Languages,
  Check,
  Download,
  Trash2,
  Power,
  RefreshCw,
  ArrowUpCircle,
  X,
  CheckCircle2,
} from 'lucide-react';
import { toast } from 'sonner';
import EngineCardShell from '@/components/resources/EngineCardShell';
import { persistDownloadSource } from '@/components/settings/gpu/gpuDownloadUtils';
import { formatSize } from '@/components/settings/gpu/gpuUtils';
import type { DownloadSource } from '../../../types/addon';
import type {
  EngineStatus,
  PyEngineDownloadProgress,
  PyEngineUpdateInfo,
} from '../../../types/engine';

const FUNASR_ENGINE_SIZE = '28MB';

type FunasrModelId = 'sensevoice-small' | 'silero-vad';

interface FunasrModelStatus {
  baseReady: boolean;
  engineInstalled: boolean;
  ready: boolean;
  models: { id: FunasrModelId; installed: boolean }[];
}

interface FunasrEngineCardProps {
  isActive: boolean;
  status?: EngineStatus;
  taskBusy: boolean;
  defaultSource: DownloadSource;
  onActivated: () => void;
  onRefreshStatuses: () => void | Promise<void>;
}

const MODEL_ORDER: FunasrModelId[] = ['sensevoice-small', 'silero-vad'];

const FunasrEngineCard: React.FC<FunasrEngineCardProps> = ({
  isActive,
  status,
  taskBusy,
  defaultSource,
  onActivated,
  onRefreshStatuses,
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

  const [modelStatus, setModelStatus] = useState<FunasrModelStatus | null>(
    null,
  );
  const [modelProgress, setModelProgress] = useState<Record<string, number>>(
    {},
  );
  const [downloadingModel, setDownloadingModel] =
    useState<FunasrModelId | null>(null);

  const [useItn, setUseItn] = useState(true);
  const [numThreads, setNumThreads] = useState(4);

  const taskBusyRef = useRef(taskBusy);
  taskBusyRef.current = taskBusy;

  const loadModelStatus = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('getFunasrModelStatus');
      if (r?.success) setModelStatus(r as FunasrModelStatus);
    } catch {
      // 忽略：保持上次状态
    }
  }, []);

  useEffect(() => {
    loadModelStatus();
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
              await loadModelStatus();
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

    const unsubModel = window?.ipc?.on(
      'downloadProgress',
      (key: string, value: number) => {
        if (typeof key !== 'string' || !key.startsWith('funasr:')) return;
        setModelProgress((prev) => ({ ...prev, [key]: value }));
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
      unsubModel?.();
      unsubUpdate?.();
    };
  }, [loadModelStatus, onRefreshStatuses, t]);

  const baseReady = modelStatus?.baseReady ?? status?.state !== 'error';
  const pkgInstalled = modelStatus?.engineInstalled ?? false;
  const modelsReady = modelStatus?.ready ?? false;
  const fullyReady = baseReady && pkgInstalled && modelsReady;

  const isDownloadingPkg =
    pkgProgress?.status === 'downloading' ||
    pkgProgress?.status === 'extracting';
  const showVerifying = verifying || pkgProgress?.status === 'verifying';
  const hasUpdate = !!(updateInfo?.hasUpdate && updateInfo.protocolSupported);

  const isModelInstalled = (id: FunasrModelId) =>
    modelStatus?.models.find((m) => m.id === id)?.installed ?? false;

  // 引擎一旦确认就绪/异常，立即清掉「检测中」，避免 ping 异常让标志卡死
  useEffect(() => {
    if (verifying && (fullyReady || status?.state === 'error')) {
      setVerifying(false);
    }
  }, [verifying, fullyReady, status?.state]);

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
      await loadModelStatus();
      await onRefreshStatuses();
    } else {
      toast.error(
        r?.error === 'engine_busy'
          ? t('engines.funasr.engineBusy')
          : r?.error || 'Failed to uninstall',
      );
    }
  };

  const handleSetActive = async () => {
    if (taskBusy) {
      toast.error(t('engines.switchBlocked'));
      return;
    }
    const r = await window?.ipc?.invoke('set-transcription-engine', 'funasr');
    if (r?.success) {
      onActivated();
      return;
    }
    if (r?.error === 'engine_not_installed') {
      setShowDownloadConfirm(true);
      return;
    }
    toast.error(r?.error || 'Failed to switch engine');
  };

  const handleDownloadModel = async (id: FunasrModelId) => {
    setDownloadingModel(id);
    try {
      const r = await window?.ipc?.invoke('downloadFunasrModel', {
        model: id,
        source: 'hf-mirror',
      });
      if (r?.success) {
        await loadModelStatus();
        await onRefreshStatuses();
      } else {
        toast.error(
          r?.error === 'anotherDownloadInProgress'
            ? t('engines.funasr.anotherDownload')
            : r?.error || 'Failed to download model',
        );
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloadingModel(null);
      setModelProgress((prev) => ({ ...prev, [`funasr:${id}`]: 0 }));
    }
  };

  const handleCancelModel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloadingModel(null);
  };

  const handleDeleteModel = async (id: FunasrModelId) => {
    const r = await window?.ipc?.invoke('deleteFunasrModel', id);
    if (r?.success) {
      await loadModelStatus();
      await onRefreshStatuses();
    } else {
      toast.error(r?.error || 'Failed to delete model');
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

  const chips = [
    t('engines.tags.multilang'),
    t('engines.tags.cpuFriendly'),
    ...(pkgInstalled
      ? []
      : [t('engines.tags.needsDownload', { size: FUNASR_ENGINE_SIZE })]),
  ];

  const badge = (() => {
    if (isActive) {
      return (
        <Badge className="shrink-0 gap-1">
          <Check className="h-3 w-3" />
          {t('engines.active')}
        </Badge>
      );
    }
    if (isDownloadingPkg) {
      return (
        <Badge variant="secondary" className="shrink-0">
          {t('engines.funasr.downloading')}
        </Badge>
      );
    }
    if (showVerifying) {
      return (
        <Badge variant="secondary" className="shrink-0">
          {t('engines.funasr.verifying')}
        </Badge>
      );
    }
    if (fullyReady) {
      return (
        <Badge variant="outline" className="border-success/40 text-success">
          {t('engines.statusAvailable')}
        </Badge>
      );
    }
    if (pkgInstalled && !modelsReady) {
      return (
        <Badge variant="outline" className="border-primary/40 text-primary">
          {t('engines.funasr.needsModels')}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="shrink-0 text-muted-foreground">
        {t('engines.funasr.notInstalled')}
      </Badge>
    );
  })();

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

  const renderModelRow = (id: FunasrModelId) => {
    const installed = isModelInstalled(id);
    const isBusy = downloadingModel === id;
    const pct = Math.round((modelProgress[`funasr:${id}`] ?? 0) * 100);
    return (
      <div
        key={id}
        className="flex items-center justify-between gap-3 rounded-md border border-muted p-2.5"
      >
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {installed && (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
            )}
            {t(`engines.funasr.models.${id}.name`)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(`engines.funasr.models.${id}.desc`)}
          </p>
          {isBusy && (
            <div className="mt-1.5 w-40">
              <Progress value={pct} />
            </div>
          )}
        </div>
        <div className="shrink-0">
          {isBusy ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              onClick={handleCancelModel}
            >
              <X className="h-3.5 w-3.5" />
              {commonT('cancel')}
            </Button>
          ) : installed ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              onClick={() => handleDeleteModel(id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('engines.funasr.modelDelete')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={!!downloadingModel}
              onClick={() => handleDownloadModel(id)}
            >
              <Download className="h-3.5 w-3.5" />
              {t('engines.funasr.modelDownload')}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <EngineCardShell
        isActive={isActive}
        icon={Languages}
        name={t('engines.funasr.name')}
        recommended
        recommendedLabel={t('engines.tags.chineseRecommended')}
        chips={chips}
        desc={t('engines.funasr.desc')}
        badge={badge}
      >
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
          {fullyReady && !isActive && (
            <Button
              size="sm"
              className="gap-1.5"
              disabled={taskBusy}
              onClick={handleSetActive}
            >
              <Power className="h-3.5 w-3.5" />
              {t('engines.setActive')}
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
          <div className="space-y-2 rounded-lg border border-muted p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {t('engines.funasr.modelsTitle')}
              </p>
              {!modelsReady && (
                <span className="text-xs text-primary">
                  {t('engines.funasr.needModelsHint')}
                </span>
              )}
            </div>
            <div className="space-y-2">{MODEL_ORDER.map(renderModelRow)}</div>
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
      </EngineCardShell>

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

export default FunasrEngineCard;

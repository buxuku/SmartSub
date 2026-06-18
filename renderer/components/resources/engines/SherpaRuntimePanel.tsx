import React, { useState } from 'react';
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
import { ArrowUpCircle, Download, RefreshCw, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import { persistDownloadSource } from '@/components/settings/gpu/gpuDownloadUtils';
import DownloadSourceSelector from '@/components/resources/engines/DownloadSourceSelector';
import type { DownloadSource } from '../../../../types/addon';
import type { EngineStatus } from '../../../../types/engine';
import type { SherpaRuntime } from './useSherpaRuntime';

const RUNTIME_SIZE = '20MB';
const BINARY_SOURCES: DownloadSource[] = ['github', 'ghproxy', 'gitcode'];

interface SherpaRuntimePanelProps {
  engineKey: 'funasr' | 'qwen';
  runtime: SherpaRuntime;
  status?: EngineStatus;
  taskBusy: boolean;
  binarySource: DownloadSource;
  onBinarySourceChange: (source: DownloadSource) => void;
  onRefreshStatuses: () => void | Promise<void>;
  infoBanner?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * FunASR / Qwen 共用的 sherpa-onnx 运行库管理面板（展示层）。
 * 运行库状态与下载进度由父组件经 useSherpaRuntime 统一持有并下传，
 * 因此在两个引擎之间切换时进度不丢失。`children` 用于各引擎专属的高级设置。
 */
const SherpaRuntimePanel: React.FC<SherpaRuntimePanelProps> = ({
  engineKey,
  runtime,
  status,
  taskBusy,
  binarySource,
  onBinarySourceChange,
  onRefreshStatuses,
  infoBanner,
  children,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');
  const k = (key: string) => `engines.${engineKey}.${key}`;

  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);

  const { installed, downloading, progress, hasUpdate, checkingUpdate } =
    runtime;

  const handleStartDownload = async () => {
    setShowDownloadConfirm(false);
    persistDownloadSource(binarySource);
    const r = await runtime.download(binarySource);
    if (!r.success) {
      toast.error(
        r.error === 'engine_busy'
          ? t(k('engineBusy'))
          : r.error || 'Failed to download runtime',
      );
      return;
    }
    await onRefreshStatuses();
  };

  const handleCheckUpdate = async () => {
    const r = await runtime.checkUpdate();
    if (!r.success) {
      toast.error(t(k('checkFailed')));
      return;
    }
    toast.success(r.hasUpdate ? t(k('updateAvailable')) : t(k('upToDate')));
  };

  const handleUninstall = async () => {
    setShowUninstallConfirm(false);
    const r = await runtime.uninstall();
    if (r.success) {
      await onRefreshStatuses();
    } else {
      toast.error(
        r.error === 'engine_busy'
          ? t(k('engineBusy'))
          : r.error || 'Failed to uninstall',
      );
    }
  };

  const sourceOptions = BINARY_SOURCES.map((s) => ({
    value: s,
    label:
      s === 'github' ? 'GitHub' : s === 'gitcode' ? 'GitCode' : t('ghProxy'),
  }));

  const uninstallButton = (
    <Button
      size="sm"
      variant="ghost"
      className="gap-1.5 text-muted-foreground"
      onClick={() => setShowUninstallConfirm(true)}
      disabled={taskBusy}
    >
      <Trash2 className="h-3.5 w-3.5" />
      {t(k('uninstall'))}
    </Button>
  );

  return (
    <>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t(k('desc'))}</p>

        {infoBanner}

        {downloading && (
          <div className="space-y-2 rounded-lg bg-muted p-3">
            <p className="text-sm font-medium">{t(k('downloading'))}</p>
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
              {t(k('downloadRuntime'), { size: RUNTIME_SIZE })}
            </Button>
          </div>
        )}

        {installed && !downloading && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {runtime.libStatus?.version && (
              <span className="text-xs text-muted-foreground">
                {t(k('installedVersion'), {
                  version: runtime.libStatus.version,
                })}
              </span>
            )}
            {hasUpdate ? (
              <>
                <Badge
                  variant="outline"
                  className="border-primary/40 text-primary"
                >
                  {t(k('updateAvailable'))}
                </Badge>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={taskBusy}
                  onClick={() => setShowDownloadConfirm(true)}
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  {t(k('upgrade'))}
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
                {checkingUpdate ? t(k('checking')) : t(k('checkUpdate'))}
              </Button>
            )}
            <span className="ml-auto">{uninstallButton}</span>
          </div>
        )}

        {installed && children && (
          <div className="space-y-3 rounded-lg border border-muted p-3">
            <p className="text-sm font-medium">{t(k('advanced'))}</p>
            {children}
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
                ? t(k('upgrade'))
                : t(k('downloadRuntime'), { size: RUNTIME_SIZE })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {installed
                ? t(k('upgradeConfirm'))
                : t(k('downloadRuntimeConfirm'), { size: RUNTIME_SIZE })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <DownloadSourceSelector
            label={t(k('downloadSource'))}
            value={binarySource}
            options={sourceOptions}
            onChange={(s) => onBinarySourceChange(s as DownloadSource)}
          />
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
                ? t(k('upgrade'))
                : t(k('downloadRuntime'), { size: RUNTIME_SIZE })}
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
            <AlertDialogTitle>{t(k('uninstall'))}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(k('uninstallConfirm'))}
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
              {t(k('uninstall'))}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default SherpaRuntimePanel;

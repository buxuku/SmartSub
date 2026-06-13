import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
import { Box, Zap, Terminal, Check, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import useLocalStorageState from 'hooks/useLocalStorageState';
import { DownSource } from 'lib/modelPanelUtils';
import { formatSize } from '@/components/settings/gpu/gpuUtils';
import type {
  EngineStatus,
  PyEngineDownloadProgress,
  PyEngineDownloadSource,
  TranscriptionEngine,
} from '../../../types/engine';

const PY_ENGINE_SIZE = '170MB';

const DEVICE_OPTIONS = ['auto', 'cpu', 'cuda'] as const;
const COMPUTE_TYPE_OPTIONS = [
  'auto',
  'float16',
  'int8',
  'int8_float16',
  'float32',
] as const;

type EngineStatuses = Partial<Record<TranscriptionEngine, EngineStatus>>;

function resolvePyEngineDownloadSource(
  downSource: DownSource,
): PyEngineDownloadSource {
  return downSource === DownSource.HfMirror ? 'ghproxy' : 'github';
}

function isQueueBusy(status: string | undefined): boolean {
  return status === 'running' || status === 'paused' || status === 'cancelling';
}

const EnginesTab = () => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');
  const router = useRouter();
  const locale = router.locale || 'zh';

  const [currentEngine, setCurrentEngine] =
    useState<TranscriptionEngine>('builtin');
  const [engineStatuses, setEngineStatuses] = useState<EngineStatuses>({});
  const [device, setDevice] = useState<'auto' | 'cpu' | 'cuda'>('auto');
  const [computeType, setComputeType] = useState('auto');
  const [whisperCommand, setWhisperCommand] = useState('');
  const [downloadProgress, setDownloadProgress] =
    useState<PyEngineDownloadProgress | null>(null);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);

  const [downSource] = useLocalStorageState<DownSource>(
    'downSource',
    DownSource.HuggingFace,
    (val) => Object.values(DownSource).includes(val as DownSource),
  );

  const refresh = useCallback(async () => {
    try {
      const [engine, statuses, settings, progress, taskStatus] =
        await Promise.all([
          window?.ipc?.invoke('get-transcription-engine'),
          window?.ipc?.invoke('get-engine-status'),
          window?.ipc?.invoke('getSettings'),
          window?.ipc?.invoke('get-py-engine-download-progress'),
          window?.ipc?.invoke('getTaskStatus'),
        ]);

      if (engine) setCurrentEngine(engine);
      if (statuses) setEngineStatuses(statuses);
      if (settings) {
        setDevice(settings.fasterWhisperDevice || 'auto');
        setComputeType(settings.fasterWhisperComputeType || 'auto');
        setWhisperCommand(settings.whisperCommand || '');
      }
      if (progress) setDownloadProgress(progress);
      setTaskBusy(isQueueBusy(taskStatus));
    } catch (error) {
      console.error('Failed to refresh engine status:', error);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unsubProgress = window?.ipc?.on(
      'py-engine-download-progress',
      (_progress: PyEngineDownloadProgress) => {
        setDownloadProgress(_progress);
        if (_progress.status === 'completed' || _progress.status === 'error') {
          refresh();
        }
      },
    );
    const unsubTask = window?.ipc?.on('taskStatusChange', (status: string) => {
      setTaskBusy(isQueueBusy(status));
    });
    return () => {
      unsubProgress?.();
      unsubTask?.();
    };
  }, [refresh]);

  const handleSelectEngine = async (engine: TranscriptionEngine) => {
    if (engine === currentEngine) return;
    if (taskBusy) {
      toast.error(t('engines.switchBlocked'));
      return;
    }

    const result = await window?.ipc?.invoke(
      'set-transcription-engine',
      engine,
    );
    if (result?.success) {
      setCurrentEngine(engine);
      return;
    }

    if (result?.error === 'engine_not_installed') {
      setShowDownloadConfirm(true);
      return;
    }

    toast.error(result?.error || 'Failed to switch engine');
  };

  const handleStartDownload = async () => {
    setShowDownloadConfirm(false);
    const source = resolvePyEngineDownloadSource(downSource);
    const result = await window?.ipc?.invoke('start-py-engine-download', {
      source,
    });
    if (!result?.success) {
      toast.error(result?.error || 'Failed to start download');
    }
  };

  const handleUninstall = async () => {
    const result = await window?.ipc?.invoke('uninstall-py-engine');
    if (result?.success) {
      await refresh();
    } else {
      toast.error(result?.error || 'Failed to uninstall');
    }
  };

  const handleDeviceChange = async (value: string) => {
    const next = value as 'auto' | 'cpu' | 'cuda';
    setDevice(next);
    await window?.ipc?.invoke('set-faster-whisper-settings', { device: next });
  };

  const handleComputeTypeChange = async (value: string) => {
    setComputeType(value);
    await window?.ipc?.invoke('set-faster-whisper-settings', {
      computeType: value,
    });
  };

  const fasterStatus = engineStatuses.fasterWhisper;
  const localCliStatus = engineStatuses.localCli;
  const isDownloading =
    downloadProgress?.status === 'downloading' ||
    downloadProgress?.status === 'extracting' ||
    fasterStatus?.state === 'downloading';
  const fasterInstalled = fasterStatus?.state === 'ready';
  const fasterBroken = fasterStatus?.state === 'error';

  const renderSelectButton = (engine: TranscriptionEngine) => {
    const isSelected = currentEngine === engine;
    return (
      <Button
        size="sm"
        variant={isSelected ? 'secondary' : 'default'}
        disabled={isSelected || taskBusy}
        onClick={() => handleSelectEngine(engine)}
        className="gap-1.5"
      >
        {isSelected && <Check className="h-3.5 w-3.5" />}
        {isSelected
          ? t('engines.fasterWhisper.selected')
          : t('engines.fasterWhisper.select')}
      </Button>
    );
  };

  const renderFasterWhisperBadge = () => {
    if (isDownloading) {
      return (
        <Badge variant="secondary">
          {t('engines.fasterWhisper.downloading')}
        </Badge>
      );
    }
    if (fasterInstalled) {
      return (
        <Badge variant="default">
          {t('engines.fasterWhisper.installed', {
            version: fasterStatus?.version || '?',
          })}
        </Badge>
      );
    }
    if (fasterBroken) {
      return (
        <Badge variant="destructive">
          {t('engines.fasterWhisper.installError')}
        </Badge>
      );
    }
    return (
      <Badge variant="outline">{t('engines.fasterWhisper.notInstalled')}</Badge>
    );
  };

  const renderLocalCliBadge = () => {
    if (localCliStatus?.state === 'ready' || whisperCommand.trim()) {
      return (
        <Badge variant="default">{t('engines.builtin.statusReady')}</Badge>
      );
    }
    return (
      <Badge variant="outline">{t('engines.fasterWhisper.notInstalled')}</Badge>
    );
  };

  return (
    <div className="space-y-4 pb-4">
      <div>
        <h2 className="text-lg font-semibold">{t('engines.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('engines.description')}
        </p>
      </div>

      <div className="grid gap-4">
        {/* whisper.cpp (builtin) */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Box className="h-4 w-4" />
                {t('engines.builtin.name')}
              </CardTitle>
              <Badge variant="default">
                {t('engines.builtin.statusReady')}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('engines.builtin.desc')}
            </p>
            <div className="flex items-center gap-2">
              {renderSelectButton('builtin')}
            </div>
          </CardContent>
        </Card>

        {/* faster-whisper */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Zap className="h-4 w-4" />
                {t('engines.fasterWhisper.name')}
              </CardTitle>
              {renderFasterWhisperBadge()}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('engines.fasterWhisper.desc')}
            </p>

            {isDownloading && downloadProgress && (
              <div className="space-y-2 rounded-lg bg-muted p-3">
                <p className="text-sm font-medium">
                  {downloadProgress.status === 'extracting'
                    ? t('engines.fasterWhisper.downloading')
                    : t('engines.fasterWhisper.downloading')}
                </p>
                <Progress value={downloadProgress.progress} />
                {downloadProgress.total > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {formatSize(downloadProgress.downloaded)} /{' '}
                    {formatSize(downloadProgress.total)}
                  </p>
                )}
              </div>
            )}

            {fasterBroken && fasterStatus?.message && (
              <p className="text-sm text-destructive">{fasterStatus.message}</p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {!fasterInstalled && !isDownloading && (
                <Button size="sm" onClick={() => setShowDownloadConfirm(true)}>
                  {t('engines.fasterWhisper.download', {
                    size: PY_ENGINE_SIZE,
                  })}
                </Button>
              )}
              {fasterInstalled && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleUninstall}
                  disabled={taskBusy}
                >
                  {t('engines.fasterWhisper.uninstall')}
                </Button>
              )}
              {renderSelectButton('fasterWhisper')}
            </div>

            {fasterInstalled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    {t('engines.fasterWhisper.device')}
                  </label>
                  <Select value={device} onValueChange={handleDeviceChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEVICE_OPTIONS.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">
                    {t('engines.fasterWhisper.computeType')}
                  </label>
                  <Select
                    value={computeType}
                    onValueChange={handleComputeTypeChange}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COMPUTE_TYPE_OPTIONS.map((opt) => (
                        <SelectItem key={opt} value={opt}>
                          {opt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* local CLI */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="h-4 w-4" />
                {t('engines.localCli.name')}
              </CardTitle>
              {renderLocalCliBadge()}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('engines.localCli.desc')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {renderSelectButton('localCli')}
              <Button size="sm" variant="outline" asChild>
                <Link href={`/${locale}/settings`}>
                  {t('engines.localCli.configure')}
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <AlertDialog
        open={showDownloadConfirm}
        onOpenChange={setShowDownloadConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('engines.fasterWhisper.download', { size: PY_ENGINE_SIZE })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('engines.fasterWhisper.downloadConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{commonT('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleStartDownload}>
              {t('engines.fasterWhisper.download', { size: PY_ENGINE_SIZE })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default EnginesTab;

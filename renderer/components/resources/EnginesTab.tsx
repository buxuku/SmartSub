import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
  Box,
  X,
  Zap,
  Terminal,
  Check,
  Cpu,
  Download,
  Trash2,
  Power,
  RefreshCw,
  ArrowUpCircle,
  SlidersHorizontal,
  ChevronDown,
  Info,
  Settings2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import SectionHeader from '@/components/SectionHeader';
import {
  readPersistedDownloadSource,
  persistDownloadSource,
} from '@/components/settings/gpu/gpuDownloadUtils';
import type { DownloadSource } from '../../../types/addon';
import { formatSize } from '@/components/settings/gpu/gpuUtils';
import type {
  EngineStatus,
  PyEngineDownloadProgress,
  PyEngineUpdateInfo,
  TranscriptionEngine,
} from '../../../types/engine';

const PY_ENGINE_SIZE = '170MB';

const COMPUTE_TYPE_OPTIONS = [
  'auto',
  'float16',
  'int8',
  'int8_float16',
  'float32',
] as const;

type EngineStatuses = Partial<Record<TranscriptionEngine, EngineStatus>>;

function isQueueBusy(status: string | undefined): boolean {
  return status === 'running' || status === 'paused' || status === 'cancelling';
}

const EnginesTab = () => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [currentEngine, setCurrentEngine] =
    useState<TranscriptionEngine>('builtin');
  const [engineStatuses, setEngineStatuses] = useState<EngineStatuses>({});
  const [device, setDevice] = useState<'auto' | 'cpu' | 'cuda'>('auto');
  const [computeType, setComputeType] = useState('auto');
  const [whisperCommand, setWhisperCommand] = useState('');
  const [showCommandConfig, setShowCommandConfig] = useState(false);
  const [platform, setPlatform] = useState('');
  const [downloadProgress, setDownloadProgress] =
    useState<PyEngineDownloadProgress | null>(null);
  const [showDownloadConfirm, setShowDownloadConfirm] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<PyEngineUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const [binarySource, setBinarySource] = useState<DownloadSource>(() =>
    typeof window === 'undefined' ? 'github' : readPersistedDownloadSource(),
  );

  const refresh = useCallback(async () => {
    try {
      const [engine, statuses, settings, progress, taskStatus, env] =
        await Promise.all([
          window?.ipc?.invoke('get-transcription-engine'),
          window?.ipc?.invoke('get-engine-status'),
          window?.ipc?.invoke('getSettings'),
          window?.ipc?.invoke('get-py-engine-download-progress'),
          window?.ipc?.invoke('getTaskStatus'),
          window?.ipc?.invoke('get-gpu-environment'),
        ]);

      if (engine) setCurrentEngine(engine);
      if (statuses) setEngineStatuses(statuses);
      if (settings) {
        setDevice(settings.fasterWhisperDevice || 'auto');
        setComputeType(settings.fasterWhisperComputeType || 'auto');
        setWhisperCommand(settings.whisperCommand || '');
      }
      if (progress) setDownloadProgress(progress);
      if (env?.platform) setPlatform(env.platform);
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
        if (_progress.status === 'completed') {
          // 下载完成后引擎还需冷启动校验（PyInstaller 首帧加载），期间保持「检测中」，
          // 避免用户以为卡住没反应、且能挡住下载/修复按钮被重复点击。
          setVerifying(true);
          // 升级/安装成功，清除"有更新"标记
          setUpdateInfo(null);
          (async () => {
            try {
              await window?.ipc?.invoke('python-engine:ping');
            } catch {
              // 校验失败：忽略错误，交给 refresh() 反映真实状态（broken → 显示修复入口）
            } finally {
              await refresh();
              setVerifying(false);
            }
          })();
        } else if (_progress.status === 'error') {
          if (_progress.error === 'protocol_unsupported') {
            toast.error(t('engines.fasterWhisper.protocolUnsupported'));
          }
          refresh();
        }
      },
    );
    const unsubTask = window?.ipc?.on('taskStatusChange', (status: string) => {
      setTaskBusy(isQueueBusy(status));
    });
    const unsubUpdate = window?.ipc?.on(
      'py-engine-update-available',
      (info: PyEngineUpdateInfo) => setUpdateInfo(info),
    );
    return () => {
      unsubProgress?.();
      unsubTask?.();
      unsubUpdate?.();
    };
  }, [refresh, t]);

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
      // 通知全局头部引擎指示器即时刷新（set-transcription-engine 不广播）
      window.dispatchEvent(new CustomEvent('transcription-engine-changed'));
      return;
    }

    if (result?.error === 'engine_not_installed') {
      setShowDownloadConfirm(true);
      return;
    }

    toast.error(result?.error || 'Failed to switch engine');
  };

  const handleSaveWhisperCommand = async () => {
    try {
      await window?.ipc?.invoke('setSettings', { whisperCommand });
      toast.success(t('engines.localCli.commandSaved'));
    } catch {
      toast.error(t('engines.localCli.commandSaveFailed'));
    }
  };

  const handleStartDownload = async () => {
    setShowDownloadConfirm(false);
    const source = binarySource;
    const result = await window?.ipc?.invoke('start-py-engine-download', {
      source,
    });
    if (!result?.success) {
      if (result?.error === 'engine_busy') {
        toast.error(t('engines.fasterWhisper.engineBusy'));
      } else {
        toast.error(result?.error || 'Failed to start download');
      }
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const source = binarySource;
      const result = await window?.ipc?.invoke('check-py-engine-update', {
        source,
      });
      if (!result?.success) {
        toast.error(t('engines.fasterWhisper.checkFailed'));
        return;
      }
      const info = result.info as PyEngineUpdateInfo;
      setUpdateInfo(info);
      if (!info.protocolSupported) {
        toast.error(t('engines.fasterWhisper.protocolUnsupported'));
      } else if (info.hasUpdate) {
        toast.success(t('engines.fasterWhisper.updateAvailable'));
      } else {
        toast.success(t('engines.fasterWhisper.upToDate'));
      }
    } catch {
      toast.error(t('engines.fasterWhisper.checkFailed'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleUpgrade = async () => {
    setShowUpgradeConfirm(false);
    const source = binarySource;
    const result = await window?.ipc?.invoke('start-py-engine-download', {
      source,
    });
    if (!result?.success) {
      if (result?.error === 'engine_busy') {
        toast.error(t('engines.fasterWhisper.engineBusy'));
      } else {
        toast.error(result?.error || 'Failed to start upgrade');
      }
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
  const hasUpdate = !!(updateInfo?.hasUpdate && updateInfo.protocolSupported);
  const localCliReady =
    localCliStatus?.state === 'ready' || whisperCommand.trim().length > 0;

  // CTranslate2(faster-whisper) 在 macOS 上不支持 CUDA/Metal，仅 CPU；其它平台保留 cuda
  const deviceOptions =
    platform === 'darwin' ? ['auto', 'cpu'] : ['auto', 'cpu', 'cuda'];
  const deviceValue = deviceOptions.includes(device) ? device : 'auto';

  const deviceLabel = (opt: string) =>
    t(`engines.fasterWhisper.deviceOptions.${opt}`);
  const computeLabel = (opt: string) =>
    opt === 'auto' ? t('engines.fasterWhisper.computeTypeOptions.auto') : opt;

  const readyBadge = (
    <Badge variant="outline" className="border-success/40 text-success">
      {t('engines.statusAvailable')}
    </Badge>
  );

  const renderEngineBadge = (engine: TranscriptionEngine) => {
    if (currentEngine === engine) {
      return (
        <Badge className="shrink-0 gap-1">
          <Check className="h-3 w-3" />
          {t('engines.active')}
        </Badge>
      );
    }
    if (engine === 'fasterWhisper') {
      if (isDownloading) {
        return (
          <Badge variant="secondary" className="shrink-0">
            {t('engines.fasterWhisper.downloading')}
          </Badge>
        );
      }
      if (verifying) {
        return (
          <Badge variant="secondary" className="shrink-0">
            {t('engines.fasterWhisper.verifying')}
          </Badge>
        );
      }
      if (fasterInstalled) return readyBadge;
      if (fasterBroken) {
        return (
          <Badge variant="destructive" className="shrink-0">
            {t('engines.fasterWhisper.installError')}
          </Badge>
        );
      }
      return (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          {t('engines.fasterWhisper.notInstalled')}
        </Badge>
      );
    }
    if (engine === 'localCli') {
      return localCliReady ? (
        readyBadge
      ) : (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          {t('engines.localCli.notConfigured')}
        </Badge>
      );
    }
    return readyBadge;
  };

  // 当前引擎以「使用中」徽章 + 卡片高亮表达，非当前才出现「设为当前引擎」主操作
  const renderSetActiveButton = (engine: TranscriptionEngine) => {
    if (currentEngine === engine) return null;
    return (
      <Button
        size="sm"
        className="gap-1.5"
        disabled={taskBusy}
        onClick={() => handleSelectEngine(engine)}
      >
        <Power className="h-3.5 w-3.5" />
        {t('engines.setActive')}
      </Button>
    );
  };

  const renderBinarySourceSelector = () => (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {t('engines.fasterWhisper.downloadSource')}
      </p>
      <div className="flex gap-2">
        {(['github', 'ghproxy', 'gitcode'] as DownloadSource[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setBinarySource(s);
              persistDownloadSource(s);
            }}
            className={`flex-1 px-3 py-2 rounded-md border text-xs transition-all ${
              binarySource === s
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

  const renderEngineCard = (config: {
    engine: TranscriptionEngine;
    icon: React.ComponentType<{ className?: string }>;
    name: string;
    recommended?: boolean;
    chips: string[];
    desc: string;
    body?: React.ReactNode;
  }) => {
    const { engine, icon: Icon, name, recommended, chips, desc, body } = config;
    const isActive = currentEngine === engine;
    return (
      <Card
        className={cn(
          'relative overflow-hidden transition-all',
          isActive && 'border-primary/60 bg-primary/[0.03] shadow-sm',
        )}
      >
        {isActive && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1 bg-primary"
          />
        )}
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <div
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {name}
                  {recommended && (
                    <Badge
                      variant="outline"
                      className="border-primary/40 px-1.5 py-0 text-[10px] font-medium text-primary"
                    >
                      {t('engines.tags.recommended')}
                    </Badge>
                  )}
                </CardTitle>
                {chips.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {chips.map((c) => (
                      <span
                        key={c}
                        className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {renderEngineBadge(engine)}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{desc}</p>
          {body}
        </CardContent>
      </Card>
    );
  };

  const advancedSettings = (
    <Collapsible className="rounded-lg border bg-muted/30">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('engines.fasterWhisper.advanced')}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">
            {t('engines.fasterWhisper.device')}: {deviceLabel(deviceValue)} ·{' '}
            {t('engines.fasterWhisper.computeType')}:{' '}
            {computeLabel(computeType)}
          </span>
          <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label htmlFor="fw-device" className="text-sm font-medium">
                {t('engines.fasterWhisper.device')}
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('engines.fasterWhisper.device')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] whitespace-pre-line text-xs leading-relaxed">
                  {t('engines.fasterWhisper.deviceTooltip')}
                </TooltipContent>
              </Tooltip>
            </div>
            <Select value={deviceValue} onValueChange={handleDeviceChange}>
              <SelectTrigger id="fw-device">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {deviceOptions.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {deviceLabel(opt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('engines.fasterWhisper.deviceHint')}
            </p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label htmlFor="fw-compute" className="text-sm font-medium">
                {t('engines.fasterWhisper.computeType')}
              </label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('engines.fasterWhisper.computeType')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] whitespace-pre-line text-xs leading-relaxed">
                  {t('engines.fasterWhisper.computeTypeTooltip')}
                </TooltipContent>
              </Tooltip>
            </div>
            <Select value={computeType} onValueChange={handleComputeTypeChange}>
              <SelectTrigger id="fw-compute">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPUTE_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {computeLabel(opt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('engines.fasterWhisper.computeTypeHint')}
            </p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-4 pb-4">
        <SectionHeader
          icon={Cpu}
          title={t('engines.title')}
          description={t('engines.description')}
        />

        <div className="grid gap-4">
          {renderEngineCard({
            engine: 'builtin',
            icon: Box,
            name: t('engines.builtin.name'),
            recommended: true,
            chips: [t('engines.tags.noDownload'), t('engines.tags.gpu')],
            desc: t('engines.builtin.desc'),
            body:
              currentEngine === 'builtin' ? null : (
                <div className="flex flex-wrap items-center gap-2">
                  {renderSetActiveButton('builtin')}
                </div>
              ),
          })}

          {renderEngineCard({
            engine: 'fasterWhisper',
            icon: Zap,
            name: t('engines.fasterWhisper.name'),
            chips: [
              t('engines.tags.faster'),
              ...(fasterInstalled
                ? []
                : [t('engines.tags.needsDownload', { size: PY_ENGINE_SIZE })]),
            ],
            desc: t('engines.fasterWhisper.desc'),
            body: (
              <>
                {isDownloading && downloadProgress && (
                  <div className="space-y-2 rounded-lg bg-muted p-3">
                    <p className="text-sm font-medium">
                      {t('engines.fasterWhisper.downloading')}
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

                {verifying && !isDownloading && (
                  <div className="rounded-lg bg-muted p-3">
                    <p className="text-sm font-medium">
                      {t('engines.fasterWhisper.verifying')}
                    </p>
                  </div>
                )}

                {fasterBroken && fasterStatus?.message && (
                  <p className="text-sm text-destructive">
                    {fasterStatus.message}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {!fasterInstalled &&
                    !isDownloading &&
                    !fasterBroken &&
                    !verifying && (
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setShowDownloadConfirm(true)}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t('engines.fasterWhisper.download', {
                          size: PY_ENGINE_SIZE,
                        })}
                      </Button>
                    )}
                  {fasterBroken && (
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setShowDownloadConfirm(true)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      {t('engines.fasterWhisper.repair')}
                    </Button>
                  )}
                  {fasterInstalled && renderSetActiveButton('fasterWhisper')}
                  {(fasterInstalled || fasterBroken) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-muted-foreground"
                      onClick={handleUninstall}
                      disabled={taskBusy}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('engines.fasterWhisper.uninstall')}
                    </Button>
                  )}
                </div>

                {fasterInstalled && !isDownloading && !verifying && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    {fasterStatus?.version && (
                      <span className="text-xs text-muted-foreground">
                        {t('engines.fasterWhisper.installedVersion', {
                          version: fasterStatus.version,
                        })}
                      </span>
                    )}
                    {hasUpdate ? (
                      <>
                        <Badge
                          variant="outline"
                          className="border-primary/40 text-primary"
                        >
                          {t('engines.fasterWhisper.updateAvailable')}
                        </Badge>
                        <Button
                          size="sm"
                          className="gap-1.5"
                          disabled={taskBusy}
                          onClick={() => setShowUpgradeConfirm(true)}
                        >
                          <ArrowUpCircle className="h-3.5 w-3.5" />
                          {t('engines.fasterWhisper.upgrade')}
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
                          ? t('engines.fasterWhisper.checking')
                          : t('engines.fasterWhisper.checkUpdate')}
                      </Button>
                    )}
                    {updateInfo && !updateInfo.protocolSupported && (
                      <span className="text-xs text-destructive">
                        {t('engines.fasterWhisper.protocolUnsupported')}
                      </span>
                    )}
                  </div>
                )}

                {fasterInstalled && (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t('engines.fasterWhisper.serialNote')}
                  </p>
                )}

                {fasterInstalled && advancedSettings}
              </>
            ),
          })}

          {renderEngineCard({
            engine: 'localCli',
            icon: Terminal,
            name: t('engines.localCli.name'),
            chips: [t('engines.tags.advanced'), t('engines.tags.byoModel')],
            desc: t('engines.localCli.desc'),
            body: (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {renderSetActiveButton('localCli')}
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    aria-expanded={showCommandConfig}
                    onClick={() => setShowCommandConfig((v) => !v)}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                    {t('engines.localCli.configure')}
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 transition-transform',
                        showCommandConfig && 'rotate-180',
                      )}
                    />
                  </Button>
                </div>
                {showCommandConfig && (
                  <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
                    <div className="flex items-center gap-1.5">
                      <label
                        htmlFor="localcli-command"
                        className="text-sm font-medium"
                      >
                        {t('engines.localCli.commandLabel')}
                      </label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={t('engines.localCli.commandLabel')}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-[260px] whitespace-pre-line text-xs leading-relaxed">
                          {t('engines.localCli.commandTooltip')}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        id="localcli-command"
                        value={whisperCommand}
                        onChange={(e) => setWhisperCommand(e.target.value)}
                        placeholder={t('engines.localCli.commandPlaceholder')}
                        className="font-mono text-sm"
                      />
                      <Button
                        size="sm"
                        className="shrink-0 gap-1.5"
                        onClick={handleSaveWhisperCommand}
                      >
                        <Check className="h-3.5 w-3.5" />
                        {t('engines.localCli.save')}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('engines.localCli.commandHint')}
                    </p>
                  </div>
                )}
              </div>
            ),
          })}
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
            {renderBinarySourceSelector()}
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
                {t('engines.fasterWhisper.download', { size: PY_ENGINE_SIZE })}
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
              <AlertDialogTitle>
                {t('engines.fasterWhisper.upgrade')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('engines.fasterWhisper.upgradeConfirm')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {renderBinarySourceSelector()}
            <AlertDialogFooter>
              <AlertDialogCancel className="gap-1.5">
                <X className="h-4 w-4" />
                {commonT('cancel')}
              </AlertDialogCancel>
              <AlertDialogAction className="gap-1.5" onClick={handleUpgrade}>
                <ArrowUpCircle className="h-4 w-4" />
                {t('engines.fasterWhisper.upgrade')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
};

export default EnginesTab;

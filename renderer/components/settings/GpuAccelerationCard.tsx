import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Zap,
  ZapOff,
  Cpu,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  ChevronDown,
  Trash2,
  FolderOpen,
  FileCode,
  ExternalLink,
  Info,
  X,
  Package,
  Copy,
  Gauge,
} from 'lucide-react';
import { toast } from 'sonner';
import { openUrl } from '@/lib/utils';
import type {
  GpuEnvironment,
  GpuMode,
  AddonVariant,
  AddonLoadResultInfo,
  AddonUpdateInfo,
  DownloadProgress,
  DownloadSource,
  CudaVersion,
} from '../../../types/addon';
import { AVAILABLE_CUDA_VERSIONS } from '../../../types/addon';

interface InstalledAddonInfo {
  version: AddonVariant;
  info: {
    installedAt: string;
    remoteVersion: string;
    hasDlls: boolean;
    size: number;
  };
}

const BACKEND_LABELS: Record<string, string> = {
  cuda: 'CUDA',
  vulkan: 'Vulkan',
  cpu: 'CPU',
  metal: 'Metal',
  coreml: 'CoreML',
  custom: 'Custom',
};

function backendDisplay(info: AddonLoadResultInfo | null): string {
  if (!info) return '';
  if (info.backend === 'cuda' && info.variant && info.variant !== 'vulkan') {
    return `CUDA ${info.variant}`;
  }
  return BACKEND_LABELS[info.backend] || info.backend;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const GpuAccelerationCard: React.FC = () => {
  const { t } = useTranslation('settings');

  const [gpuEnv, setGpuEnv] = useState<GpuEnvironment | null>(null);
  const [activeBackend, setActiveBackend] =
    useState<AddonLoadResultInfo | null>(null);
  const [gpuMode, setGpuMode] = useState<GpuMode>('auto');
  const [installedAddons, setInstalledAddons] = useState<InstalledAddonInfo[]>(
    [],
  );
  const [selectedVersion, setSelectedVersion] = useState<AddonVariant | null>(
    null,
  );
  const [customAddonPath, setCustomAddonPath] = useState<string | null>(null);
  const [updates, setUpdates] = useState<AddonUpdateInfo[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null);
  const [downloadSource, setDownloadSource] =
    useState<DownloadSource>('github');
  const [downloadingVariant, setDownloadingVariant] =
    useState<AddonVariant | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const lastToastStatus = useRef<string | null>(null);
  const downloadingVariantRef = useRef<AddonVariant | null>(null);

  const isDesktopGpuPlatform = gpuEnv ? gpuEnv.platform !== 'darwin' : false;

  const loadData = useCallback(async (forceRefresh = false) => {
    try {
      setIsLoading(true);
      const env = await window?.ipc?.invoke(
        'get-gpu-environment',
        forceRefresh,
      );
      setGpuEnv(env);

      const active = await window?.ipc?.invoke('get-active-backend');
      setActiveBackend(active);

      const addons = await window?.ipc?.invoke('get-installed-addons');
      setInstalledAddons(addons || []);

      const selected = await window?.ipc?.invoke('get-selected-addon-version');
      setSelectedVersion(selected);

      const customPath = await window?.ipc?.invoke('get-custom-addon-path');
      setCustomAddonPath(customPath);

      const settings = await window?.ipc?.invoke('getSettings');
      setGpuMode(settings?.gpuMode || 'auto');
    } catch (error) {
      console.error('Failed to load GPU acceleration data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const notifyGpuSettingsChanged = () => {
    window.dispatchEvent(new Event('gpu-settings-changed'));
  };

  // 下载进度
  useEffect(() => {
    const handleProgress = async (progress: DownloadProgress) => {
      setDownloadProgress(progress);

      if (progress.status === 'completed') {
        if (lastToastStatus.current !== 'completed') {
          toast.success(t('gpuAcceleration.downloadComplete'));
          lastToastStatus.current = 'completed';
        }
        setTimeout(async () => {
          setDownloadProgress(null);
          setDownloadingVariant(null);
          downloadingVariantRef.current = null;
          // 主进程下载完成后已自动 registerInstalledAddon + selectAddonVersion
          await loadData();
          notifyGpuSettingsChanged();
        }, 1000);
      } else if (progress.status === 'error') {
        if (lastToastStatus.current !== 'error') {
          toast.error(progress.error || t('gpuAcceleration.downloadFailed'));
          lastToastStatus.current = 'error';
        }
        setDownloadingVariant(null);
        downloadingVariantRef.current = null;
      } else if (progress.status === 'downloading') {
        lastToastStatus.current = null;
      }
    };

    const cleanup = window?.ipc?.on('addon-download-progress', handleProgress);
    return () => {
      cleanup?.();
    };
  }, [loadData, t]);

  // 后端变更推送（转写触发加载后刷新状态卡）
  useEffect(() => {
    const cleanup = window?.ipc?.on(
      'active-backend-changed',
      (info: AddonLoadResultInfo) => {
        setActiveBackend(info);
      },
    );
    return () => {
      cleanup?.();
    };
  }, []);

  // ===== 操作 =====

  const handleModeChange = async (mode: GpuMode) => {
    try {
      await window?.ipc?.invoke('setSettings', { gpuMode: mode });
      setGpuMode(mode);
      notifyGpuSettingsChanged();
      toast.success(t('gpuAcceleration.modeChanged'));
      if (mode === 'gpu-only') {
        toast.warning(t('gpuAcceleration.gpuOnlyWarning'));
      }
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  const handleDownload = async (
    variant: AddonVariant,
    forceType?: 'node.gz' | 'tar.gz',
  ) => {
    const downloadType: 'node.gz' | 'tar.gz' =
      variant === 'vulkan'
        ? 'node.gz'
        : (forceType ??
          (gpuEnv?.nvidia?.recommendation.needsDlls ? 'tar.gz' : 'node.gz'));
    setDownloadingVariant(variant);
    downloadingVariantRef.current = variant;
    try {
      await window?.ipc?.invoke('start-addon-download', {
        source: downloadSource,
        variant,
        type: downloadType,
      });
      toast.info(t('gpuAcceleration.downloadStarted'));
    } catch (error) {
      toast.error(t('gpuAcceleration.downloadFailed'));
      setDownloadingVariant(null);
      downloadingVariantRef.current = null;
    }
  };

  const handleCancelDownload = async () => {
    try {
      await window?.ipc?.invoke('cancel-addon-download');
      setDownloadProgress(null);
      setDownloadingVariant(null);
      downloadingVariantRef.current = null;
      toast.info(t('gpuAcceleration.downloadCancelled'));
    } catch (error) {
      console.error('Failed to cancel download:', error);
    }
  };

  const isVariantInstalled = (variant: AddonVariant): boolean =>
    installedAddons.some((a) => a.version === variant);

  // 后端下拉选择：builtin-vulkan = 清空选择走默认链；其它 = 选中（未安装则触发下载）
  const handleBackendSelect = async (value: string) => {
    try {
      if (customAddonPath) {
        await window?.ipc?.invoke('set-custom-addon-path', null);
        setCustomAddonPath(null);
      }
      if (value === 'builtin-vulkan') {
        await window?.ipc?.invoke('select-addon-version', null);
        setSelectedVersion(null);
        notifyGpuSettingsChanged();
        toast.success(t('gpuAcceleration.versionSelected'));
        return;
      }
      const variant = value as AddonVariant;
      if (isVariantInstalled(variant)) {
        await window?.ipc?.invoke('select-addon-version', variant);
        setSelectedVersion(variant);
        notifyGpuSettingsChanged();
        toast.success(t('gpuAcceleration.versionSelected'));
      } else {
        await handleDownload(variant);
      }
    } catch (error) {
      toast.error(t('saveFailed'));
    }
  };

  const handleRemoveAddon = async (variant: AddonVariant) => {
    try {
      await window?.ipc?.invoke('remove-addon', variant);
      toast.success(t('gpuAcceleration.addonRemoved'));
      loadData();
      notifyGpuSettingsChanged();
    } catch (error) {
      toast.error(t('gpuAcceleration.removeFailed'));
    }
  };

  const handleCheckUpdates = async () => {
    setCheckingUpdates(true);
    try {
      const updateInfo = await window?.ipc?.invoke('check-addon-updates');
      setUpdates(updateInfo || []);
      const hasUpdates = updateInfo?.some((u: AddonUpdateInfo) => u.hasUpdate);
      if (hasUpdates) {
        toast.info(t('gpuAcceleration.updatesAvailable'));
      } else {
        toast.success(t('gpuAcceleration.noUpdates'));
      }
    } catch (error) {
      toast.error(t('gpuAcceleration.checkUpdatesFailed'));
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleSelectCustomAddon = async () => {
    try {
      const result = await window?.ipc?.invoke('select-addon-file');
      if (result?.canceled || !result?.filePath) return;
      const setResult = await window?.ipc?.invoke(
        'set-custom-addon-path',
        result.filePath,
      );
      if (setResult?.success) {
        setCustomAddonPath(result.filePath);
        setSelectedVersion(null);
        notifyGpuSettingsChanged();
        toast.success(t('gpuAcceleration.customAddonSet'));
      } else {
        toast.error(
          setResult?.error || t('gpuAcceleration.customAddonSetFailed'),
        );
      }
    } catch (error) {
      toast.error(t('gpuAcceleration.customAddonSetFailed'));
    }
  };

  const handleClearCustomAddon = async () => {
    try {
      await window?.ipc?.invoke('set-custom-addon-path', null);
      setCustomAddonPath(null);
      notifyGpuSettingsChanged();
      toast.info(t('gpuAcceleration.customAddonCleared'));
      loadData();
    } catch (error) {
      console.error('Failed to clear custom addon path:', error);
    }
  };

  const handleCopyDiagnostics = async () => {
    const diag = {
      gpuEnv,
      activeBackend,
      gpuMode,
      selectedVersion,
      customAddonPath,
      installed: installedAddons,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      toast.success(t('gpuAcceleration.diagnosticsCopied'));
    } catch {
      toast.error(t('gpuAcceleration.diagnosticsCopied'));
    }
  };

  // ===== 派生状态 =====

  const nvidiaRecommendation = gpuEnv?.nvidia?.recommendation;
  const recommendedCudaVersion = nvidiaRecommendation?.recommendedVersion;
  const cudaApplicable = !!nvidiaRecommendation?.canUseCuda;
  const activeLabel = backendDisplay(activeBackend);
  const isCudaActive = activeBackend?.backend === 'cuda';
  const showUpgradeButton =
    isDesktopGpuPlatform &&
    gpuMode !== 'cpu-only' &&
    cudaApplicable &&
    !!recommendedCudaVersion &&
    !isCudaActive &&
    !(selectedVersion && selectedVersion !== 'vulkan') &&
    !customAddonPath;

  const gpuName =
    gpuEnv?.gpus?.[0]?.name ||
    gpuEnv?.nvidia?.gpuSupport?.gpuName ||
    t('gpuAcceleration.notDetected');

  type StatusTone = 'green' | 'yellow' | 'gray' | 'neutral';
  const deriveStatus = (): { tone: StatusTone; title: string } => {
    if (gpuMode === 'cpu-only') {
      return { tone: 'gray', title: t('gpuAcceleration.statusCpuManual') };
    }
    if (!activeBackend) {
      return { tone: 'neutral', title: t('gpuAcceleration.statusAutoReady') };
    }
    if (activeBackend.backend === 'cpu') {
      return {
        tone: isDesktopGpuPlatform ? 'yellow' : 'gray',
        title: isDesktopGpuPlatform
          ? t('gpuAcceleration.statusFallback', { backend: 'CPU' })
          : t('gpuAcceleration.statusCpu'),
      };
    }
    if (activeBackend.fallback) {
      return {
        tone: 'yellow',
        title: t('gpuAcceleration.statusFallback', { backend: activeLabel }),
      };
    }
    return {
      tone: 'green',
      title: t('gpuAcceleration.statusRunningGpu', { backend: activeLabel }),
    };
  };
  const status = deriveStatus();

  const statusToneClasses: Record<StatusTone, string> = {
    green:
      'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30',
    yellow:
      'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30',
    gray: 'border-muted bg-muted/40',
    neutral: 'border-muted bg-muted/40',
  };

  const renderStatusIcon = () => {
    if (status.tone === 'green')
      return <Zap className="w-5 h-5 text-green-600 dark:text-green-400" />;
    if (status.tone === 'yellow')
      return <AlertTriangle className="w-5 h-5 text-amber-500" />;
    if (gpuMode === 'cpu-only')
      return <ZapOff className="w-5 h-5 text-muted-foreground" />;
    return <Cpu className="w-5 h-5 text-muted-foreground" />;
  };

  // ===== 渲染 =====

  if (isLoading) {
    return (
      <Card id="gpu-acceleration">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Zap className="mr-2" />
            {t('gpuAcceleration.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const renderDownloadProgress = () => {
    if (!downloadProgress || downloadProgress.status === 'idle') return null;
    const isDownloading = downloadProgress.status === 'downloading';
    const isExtracting = downloadProgress.status === 'extracting';
    const isError = downloadProgress.status === 'error';
    const variantLabel =
      downloadingVariant === 'vulkan'
        ? 'Vulkan'
        : downloadingVariant
          ? `CUDA ${downloadingVariant}`
          : '';

    return (
      <div className="space-y-2 p-3 bg-muted rounded-lg">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {variantLabel && `${variantLabel}: `}
            {isDownloading && t('gpuAcceleration.downloading')}
            {isExtracting && t('gpuAcceleration.extracting')}
            {isError && t('gpuAcceleration.downloadFailed')}
          </span>
          <div className="flex items-center gap-2">
            {isError && downloadingVariant && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDownload(downloadingVariant)}
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                {t('gpuAcceleration.retry')}
              </Button>
            )}
            {isDownloading && (
              <Button variant="ghost" size="sm" onClick={handleCancelDownload}>
                {t('cancel')}
              </Button>
            )}
            {isError && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDownloadProgress(null);
                  setDownloadingVariant(null);
                }}
              >
                {t('gpuAcceleration.dismiss')}
              </Button>
            )}
          </div>
        </div>
        <Progress value={downloadProgress.progress} />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {formatSize(downloadProgress.downloaded)} /{' '}
            {formatSize(downloadProgress.total)}
          </span>
          {isDownloading && downloadProgress.speed > 0 && (
            <span>
              {formatSize(downloadProgress.speed)}/s ·{' '}
              {formatEta(downloadProgress.eta)}
            </span>
          )}
          {isError && downloadProgress.error && (
            <span className="text-destructive">{downloadProgress.error}</span>
          )}
        </div>
      </div>
    );
  };

  const modeOptions: { value: GpuMode; label: string; desc: string }[] = [
    {
      value: 'auto',
      label: t('gpuAcceleration.modeAuto'),
      desc: t('gpuAcceleration.modeAutoDesc'),
    },
    {
      value: 'gpu-only',
      label: t('gpuAcceleration.modeGpuOnly'),
      desc: t('gpuAcceleration.modeGpuOnlyDesc'),
    },
    {
      value: 'cpu-only',
      label: t('gpuAcceleration.modeCpuOnly'),
      desc: t('gpuAcceleration.modeCpuOnlyDesc'),
    },
  ];

  const backendSelectValue = customAddonPath
    ? 'custom'
    : (selectedVersion ?? 'builtin-vulkan');

  const selectedCudaInstalled = installedAddons.find(
    (a) => a.version === selectedVersion && a.version !== 'vulkan',
  );
  const vulkanUpdate = updates.find(
    (u) => u.variant === 'vulkan' && u.hasUpdate,
  );

  return (
    <Card id="gpu-acceleration">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center">
            <Zap className="mr-2" />
            {t('gpuAcceleration.title')}
          </div>
          <Button variant="ghost" size="sm" onClick={() => loadData(true)}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* 状态卡 */}
        <div
          className={`rounded-lg border-2 p-4 space-y-2 ${statusToneClasses[status.tone]}`}
        >
          <div className="flex items-center gap-2">
            {renderStatusIcon()}
            <span className="font-semibold text-sm">{status.title}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {gpuName}
            {gpuEnv?.nvidia?.gpuSupport?.driverVersion &&
              ` · ${t('gpuAcceleration.driver')} ${gpuEnv.nvidia.gpuSupport.driverVersion}`}
          </div>
          {status.tone === 'yellow' &&
            (activeBackend?.failedAttempts?.length ?? 0) > 0 && (
              <div className="text-xs text-amber-700 dark:text-amber-400">
                {activeBackend.failedAttempts[0].error}
              </div>
            )}
          {status.tone !== 'green' &&
            isDesktopGpuPlatform &&
            !gpuEnv?.vulkanRuntime && (
              <div className="text-xs text-muted-foreground">
                {t('gpuAcceleration.updateDriverHint')}
                {gpuEnv?.platform === 'linux' &&
                  ` ${t('gpuAcceleration.linuxVulkanHint')}`}
              </div>
            )}
          {showUpgradeButton && (
            <div className="pt-2 border-t border-current/10 space-y-2">
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <Gauge className="w-3.5 h-3.5" />
                {t('gpuAcceleration.upgradeHint', { gpu: gpuName })}
              </div>
              <Button
                size="sm"
                onClick={() => handleDownload(recommendedCudaVersion)}
                disabled={!!downloadingVariant}
              >
                {t('gpuAcceleration.upgradeToCuda', {
                  version: recommendedCudaVersion,
                })}
              </Button>
            </div>
          )}
        </div>

        {/* 下载进度（全局可见） */}
        {renderDownloadProgress()}

        {/* 加速模式（macOS 隐藏） */}
        {isDesktopGpuPlatform && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">
              {t('gpuAcceleration.modeTitle')}
            </h4>
            <div className="grid grid-cols-3 gap-2">
              {modeOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleModeChange(opt.value)}
                  className={`p-2.5 rounded-lg border-2 text-left transition-all ${
                    gpuMode === opt.value
                      ? 'border-primary bg-primary/5'
                      : 'border-muted hover:border-primary/50'
                  }`}
                >
                  <div className="text-sm font-medium">{opt.label}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {opt.desc}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 高级选项（macOS 隐藏） */}
        {isDesktopGpuPlatform && (
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 text-sm font-medium w-full"
              >
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${advancedOpen ? '' : '-rotate-90'}`}
                />
                {t('gpuAcceleration.advancedOptions')}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3 space-y-4">
              {/* 后端选择 */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {t('gpuAcceleration.backendSelect')}
                </span>
                <Select
                  value={backendSelectValue}
                  onValueChange={handleBackendSelect}
                  disabled={!!downloadingVariant}
                >
                  <SelectTrigger className="w-[280px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {customAddonPath && (
                      <SelectItem value="custom" disabled>
                        {t('gpuAcceleration.customAddonActive')}
                      </SelectItem>
                    )}
                    <SelectGroup>
                      <SelectLabel className="text-[11px]">
                        {t('gpuAcceleration.backendGroupUniversal')}
                      </SelectLabel>
                      <SelectItem value="builtin-vulkan">
                        {t('gpuAcceleration.vulkanBuiltin')}
                      </SelectItem>
                      {isVariantInstalled('vulkan') && (
                        <SelectItem value="vulkan">
                          {t('gpuAcceleration.vulkanUserData')}
                        </SelectItem>
                      )}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel className="text-[11px]">
                        {t('gpuAcceleration.backendGroupCuda')}
                        {!cudaApplicable &&
                          ` — ${t('gpuAcceleration.cudaNotApplicable')}`}
                      </SelectLabel>
                      {AVAILABLE_CUDA_VERSIONS.map((version: CudaVersion) => (
                        <SelectItem
                          key={version}
                          value={version}
                          disabled={!cudaApplicable}
                        >
                          CUDA {version}
                          {version === recommendedCudaVersion &&
                            ` · ${t('gpuAcceleration.recommended')}`}
                          {!isVariantInstalled(version) &&
                            ` · ${t('gpuAcceleration.selectToDownload')}`}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              {/* CUDA 包类型（仅选中已安装 CUDA 时） */}
              {selectedCudaInstalled && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">
                    {t('gpuAcceleration.packageType')}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[11px]">
                      <Package className="w-3 h-3 mr-1" />
                      {selectedCudaInstalled.info.hasDlls
                        ? t('gpuAcceleration.fullEdition')
                        : t('gpuAcceleration.liteEdition')}
                    </Badge>
                    {(selectedCudaInstalled.info.hasDlls
                      ? gpuEnv?.nvidia?.cudaToolkit.installed
                      : true) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!!downloadingVariant}
                        onClick={() =>
                          handleDownload(
                            selectedCudaInstalled.version,
                            selectedCudaInstalled.info.hasDlls
                              ? 'node.gz'
                              : 'tar.gz',
                          )
                        }
                      >
                        {selectedCudaInstalled.info.hasDlls
                          ? t('gpuAcceleration.switchToLite')
                          : t('gpuAcceleration.switchToFull')}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* 完整版/轻量版区别说明（CUDA 可用时始终展示，下载前即可知晓） */}
              {cudaApplicable && (
                <div className="flex items-start gap-2 p-2.5 bg-muted/50 rounded-md">
                  <Package className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="text-[11px] text-muted-foreground space-y-1">
                    <p>{t('gpuAcceleration.packageTypeHintFull')}</p>
                    <p>{t('gpuAcceleration.packageTypeHintLite')}</p>
                    <p>{t('gpuAcceleration.packageTypeHintAuto')}</p>
                  </div>
                </div>
              )}

              {/* 下载源 */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  {t('gpuAcceleration.downloadSource')}
                </span>
                <Select
                  value={downloadSource}
                  onValueChange={(v) => setDownloadSource(v as DownloadSource)}
                >
                  <SelectTrigger className="w-[200px] h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="ghproxy">
                      {t('gpuAcceleration.ghProxy')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 已安装管理 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {t('gpuAcceleration.installedManagement')}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={handleCheckUpdates}
                    disabled={checkingUpdates}
                  >
                    <RefreshCw
                      className={`w-3 h-3 mr-1 ${checkingUpdates ? 'animate-spin' : ''}`}
                    />
                    {t('gpuAcceleration.checkNewVersion')}
                  </Button>
                </div>

                {/* 内置 Vulkan 行 */}
                {gpuEnv?.builtinVulkanAvailable && (
                  <div className="flex items-center justify-between p-2 rounded-md border text-xs">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                      <span>Vulkan</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {t('gpuAcceleration.builtin')}
                      </Badge>
                    </div>
                    {vulkanUpdate && !isVariantInstalled('vulkan') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[11px] text-amber-600"
                        disabled={!!downloadingVariant}
                        onClick={() => handleDownload('vulkan')}
                      >
                        <RefreshCw className="w-3 h-3 mr-1" />
                        {t('gpuAcceleration.update')}
                      </Button>
                    )}
                  </div>
                )}

                {/* userData 安装项 */}
                {installedAddons.map((addon) => {
                  const hasUpdate = updates.find(
                    (u) => u.variant === addon.version && u.hasUpdate,
                  );
                  const label =
                    addon.version === 'vulkan'
                      ? 'Vulkan'
                      : `CUDA ${addon.version}`;
                  return (
                    <div
                      key={addon.version}
                      className="flex items-center justify-between p-2 rounded-md border text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                        <span>{label}</span>
                        <span className="text-muted-foreground">
                          v{addon.info.remoteVersion} ·{' '}
                          {formatSize(addon.info.size)}
                        </span>
                        {addon.version !== 'vulkan' && (
                          <Badge variant="outline" className="text-[10px]">
                            {addon.info.hasDlls
                              ? t('gpuAcceleration.fullEdition')
                              : t('gpuAcceleration.liteEdition')}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {hasUpdate && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[11px] text-amber-600"
                            disabled={!!downloadingVariant}
                            onClick={() => handleDownload(addon.version)}
                          >
                            <RefreshCw className="w-3 h-3 mr-1" />
                            {t('gpuAcceleration.update')}
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-destructive"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                {t('gpuAcceleration.confirmDelete')}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {t('gpuAcceleration.confirmDeleteDesc', {
                                  version: label,
                                })}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>
                                {t('cancel')}
                              </AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleRemoveAddon(addon.version)}
                              >
                                {t('delete')}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 自定义加速包 */}
              <div className="pt-3 border-t border-dashed space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileCode className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {t('gpuAcceleration.customAddonPath')}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      openUrl(
                        'https://github.com/buxuku/whisper.cpp/releases/tag/latest',
                      )
                    }
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {t('gpuAcceleration.downloadPackageUrl')}
                  </button>
                </div>
                <div className="flex items-start gap-2 p-2.5 bg-muted/50 rounded-md">
                  <Info className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="text-[11px] text-muted-foreground space-y-1">
                    <p>{t('gpuAcceleration.customAddonTip')}</p>
                    <p>{t('gpuAcceleration.customAddonDllTip')}</p>
                  </div>
                </div>
                {customAddonPath ? (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg border-2 border-primary bg-primary/5">
                    <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {t('gpuAcceleration.customAddonActive')}
                      </div>
                      <div
                        className="text-[11px] text-muted-foreground truncate"
                        title={customAddonPath}
                      >
                        {customAddonPath}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={handleSelectCustomAddon}
                      >
                        <FolderOpen className="w-3.5 h-3.5 mr-1" />
                        {t('gpuAcceleration.selectAddonFile')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive"
                        onClick={handleClearCustomAddon}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-9 text-xs"
                    onClick={handleSelectCustomAddon}
                  >
                    <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
                    {t('gpuAcceleration.selectAddonFile')}
                  </Button>
                )}
              </div>

              {/* 闪退提示 */}
              <div className="flex items-start gap-2 p-2.5 bg-amber-50 dark:bg-amber-950/30 rounded-md border border-amber-200 dark:border-amber-800">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                <span className="text-[11px] text-amber-700 dark:text-amber-400">
                  {t('gpuAcceleration.crashTip')}
                </span>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* 检测详情（全平台可见） */}
        <Collapsible open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-sm font-medium w-full"
            >
              <ChevronDown
                className={`w-4 h-4 transition-transform ${diagnosticsOpen ? '' : '-rotate-90'}`}
              />
              {t('gpuAcceleration.diagnostics')}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t('gpuAcceleration.gpu')}
                </span>
                <span className="font-medium text-right">
                  {gpuEnv?.gpus?.length
                    ? gpuEnv.gpus.map((g) => g.name).join(' / ')
                    : t('gpuAcceleration.notDetected')}
                </span>
              </div>
              {isDesktopGpuPlatform && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t('gpuAcceleration.vulkanRuntimeLabel')}
                  </span>
                  <span>
                    {gpuEnv?.vulkanRuntime
                      ? `✓ ${t('gpuAcceleration.detected')}`
                      : `✗ ${t('gpuAcceleration.notDetected')}`}
                  </span>
                </div>
              )}
              {gpuEnv?.nvidia && (
                <>
                  {gpuEnv.nvidia.gpuSupport.maxCudaVersion && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        {t('gpuAcceleration.maxCuda')}
                      </span>
                      <span>{gpuEnv.nvidia.gpuSupport.maxCudaVersion}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">
                      {t('gpuAcceleration.cudaToolkit')}
                    </span>
                    <span>
                      {gpuEnv.nvidia.cudaToolkit.installed
                        ? gpuEnv.nvidia.cudaToolkit.version ||
                          t('gpuAcceleration.installed')
                        : t('gpuAcceleration.notInstalled')}
                    </span>
                  </div>
                </>
              )}
              <div className="flex items-center justify-between border-t pt-2">
                <span className="text-muted-foreground">
                  {t('gpuAcceleration.lastLoad')}
                </span>
                <span className="text-right">
                  {activeBackend
                    ? `${activeLabel} · ${
                        activeBackend.fallback
                          ? t('gpuAcceleration.loadFallbackBadge')
                          : t('gpuAcceleration.loadSuccess')
                      } · ${new Date(activeBackend.loadedAt).toLocaleString()}`
                    : t('gpuAcceleration.noLoadYet')}
                </span>
              </div>
              {(activeBackend?.failedAttempts?.length ?? 0) > 0 && (
                <div className="space-y-1">
                  <span className="text-muted-foreground">
                    {t('gpuAcceleration.failureDetails')}
                  </span>
                  {activeBackend.failedAttempts.map((a, idx) => (
                    <div
                      key={idx}
                      className="text-[11px] text-muted-foreground pl-2 break-all"
                    >
                      {BACKEND_LABELS[a.backend] || a.backend}: {a.error}
                    </div>
                  ))}
                </div>
              )}
              <div className="pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleCopyDiagnostics}
                >
                  <Copy className="w-3 h-3 mr-1" />
                  {t('gpuAcceleration.copyDiagnostics')}
                </Button>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
};

export default GpuAccelerationCard;

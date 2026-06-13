import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Zap, RefreshCw, ChevronDown, Info } from 'lucide-react';
import { toast } from 'sonner';
import type {
  GpuEnvironment,
  GpuMode,
  AddonVariant,
  AddonLoadResultInfo,
  AddonUpdateInfo,
  DownloadProgress,
  DownloadSource,
  CudaVersion,
  RemoteAddonVersions,
} from '../../../types/addon';
import { parseRemoteCudaVersions } from './gpu/gpuDownloadUtils';
import CudaDownloadSheet from './gpu/CudaDownloadSheet';
import GpuStatusHero from './gpu/GpuStatusHero';
import GpuModeSelector from './gpu/GpuModeSelector';
import GpuBackendSwitcher from './gpu/GpuBackendSwitcher';
import GpuDownloadProgress from './gpu/GpuDownloadProgress';
import GpuInstalledList from './gpu/GpuInstalledList';
import GpuCustomAddonSection from './gpu/GpuCustomAddonSection';
import GpuDiagnosticsPanel from './gpu/GpuDiagnosticsPanel';
import {
  persistDownloadSource,
  readPersistedDownloadSource,
  fetchPackageSizeHints,
  editionToDownloadType,
  getDefaultPackageEdition,
} from './gpu/gpuDownloadUtils';
import { resolveActiveBackendForPlatform, formatSize } from './gpu/gpuUtils';
import type { CudaDownloadSheetState, InstalledAddonInfo } from './gpu/types';

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
  const [downloadSource, setDownloadSource] = useState<DownloadSource>(() =>
    readPersistedDownloadSource(),
  );
  const [downloadingVariant, setDownloadingVariant] =
    useState<AddonVariant | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sheetState, setSheetState] = useState<CudaDownloadSheetState>({
    open: false,
    presetVersion: null,
  });
  const [availableCudaVersions, setAvailableCudaVersions] = useState<
    CudaVersion[]
  >([]);
  const [usedRemoteFallback, setUsedRemoteFallback] = useState(false);
  const [upgradeSizeHint, setUpgradeSizeHint] = useState<string | null>(null);
  const lastToastStatus = useRef<string | null>(null);
  const downloadingVariantRef = useRef<AddonVariant | null>(null);
  const downloadSourceRef = useRef<DownloadSource>(downloadSource);
  const failedCudaVersionRef = useRef<CudaVersion | null>(null);

  useEffect(() => {
    downloadSourceRef.current = downloadSource;
  }, [downloadSource]);

  const isDesktopGpuPlatform = gpuEnv ? gpuEnv.platform !== 'darwin' : false;
  const cudaApplicable = !!gpuEnv?.nvidia?.recommendation.canUseCuda;

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

      const remote = (await window?.ipc?.invoke(
        'get-remote-addon-versions',
      )) as RemoteAddonVersions | null;
      setAvailableCudaVersions(parseRemoteCudaVersions(remote));
      setUsedRemoteFallback(!remote);

      const recommended = env?.nvidia?.recommendation.recommendedVersion;
      if (recommended && env?.nvidia?.recommendation.canUseCuda) {
        const edition = getDefaultPackageEdition(env);
        const type = editionToDownloadType(edition);
        const source = downloadSourceRef.current;
        const hints = await fetchPackageSizeHints(recommended, source);
        const bytes = edition === 'full' ? hints.full : hints.lite;
        setUpgradeSizeHint(bytes ? formatSize(bytes) : null);
      } else {
        setUpgradeSizeHint(null);
      }
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

  const openDownloadSheet = (presetVersion?: CudaVersion | null) => {
    if (downloadingVariant) return;
    setSheetState({
      open: true,
      presetVersion: presetVersion ?? null,
    });
  };

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
          failedCudaVersionRef.current = null;
          await loadData();
          notifyGpuSettingsChanged();
        }, 1000);
      } else if (progress.status === 'error') {
        if (lastToastStatus.current !== 'error') {
          const failedVariant = downloadingVariantRef.current;
          const currentSource = downloadSourceRef.current;
          const isCudaFailure =
            failedVariant && failedVariant !== 'vulkan'
              ? (failedVariant as CudaVersion)
              : null;
          if (isCudaFailure) {
            failedCudaVersionRef.current = isCudaFailure;
          }

          toast.error(progress.error || t('gpuAcceleration.downloadFailed'), {
            action:
              currentSource === 'github' && isCudaFailure
                ? {
                    label: t('gpuAcceleration.switchMirrorAndRetry'),
                    onClick: () => {
                      setDownloadSource('ghproxy');
                      persistDownloadSource('ghproxy');
                      setSheetState({
                        open: true,
                        presetVersion: failedCudaVersionRef.current,
                      });
                    },
                  }
                : undefined,
          });
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

  const handleModeChange = async (mode: GpuMode) => {
    try {
      await window?.ipc?.invoke('setSettings', { gpuMode: mode });
      setGpuMode(mode);
      notifyGpuSettingsChanged();
      toast.success(t('gpuAcceleration.modeChanged'));
      if (mode === 'gpu-only') {
        toast.warning(t('gpuAcceleration.gpuOnlyWarning'));
      }
    } catch {
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
    } catch {
      toast.error(t('gpuAcceleration.downloadFailed'));
      setDownloadingVariant(null);
      downloadingVariantRef.current = null;
    }
  };

  const handleCudaDownload = (
    variant: CudaVersion,
    type: 'node.gz' | 'tar.gz',
  ) => {
    void handleDownload(variant, type);
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

  const handleSelectBackend = async (variant: AddonVariant | null) => {
    try {
      if (customAddonPath) {
        await window?.ipc?.invoke('set-custom-addon-path', null);
        setCustomAddonPath(null);
      }
      await window?.ipc?.invoke('select-addon-version', variant);
      setSelectedVersion(variant);
      notifyGpuSettingsChanged();
      toast.success(t('gpuAcceleration.versionSelected'));
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const handleRemoveAddon = async (variant: AddonVariant) => {
    try {
      await window?.ipc?.invoke('remove-addon', variant);
      toast.success(t('gpuAcceleration.addonRemoved'));
      loadData();
      notifyGpuSettingsChanged();
    } catch {
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
    } catch {
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
    } catch {
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

  const handleDownloadSourceChange = (source: DownloadSource) => {
    setDownloadSource(source);
    persistDownloadSource(source);
  };

  if (isLoading || !gpuEnv) {
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
        <GpuStatusHero
          gpuEnv={gpuEnv}
          activeBackend={resolveActiveBackendForPlatform(activeBackend, gpuEnv)}
          gpuMode={gpuMode}
          isDesktopGpuPlatform={isDesktopGpuPlatform}
          selectedVersion={selectedVersion}
          customAddonPath={customAddonPath}
          downloadingVariant={downloadingVariant}
          upgradeSizeHint={upgradeSizeHint}
          onOpenDownloadSheet={() => openDownloadSheet()}
          onManageInstalled={() => setMoreOpen(true)}
        />

        <GpuDownloadProgress
          downloadProgress={downloadProgress}
          downloadingVariant={downloadingVariant}
          onRetry={(variant) => void handleDownload(variant)}
          onCancel={() => void handleCancelDownload()}
          onDismiss={() => {
            setDownloadProgress(null);
            setDownloadingVariant(null);
          }}
        />

        {isDesktopGpuPlatform && (
          <>
            <GpuModeSelector
              gpuMode={gpuMode}
              onModeChange={handleModeChange}
            />

            <GpuBackendSwitcher
              gpuEnv={gpuEnv}
              installedAddons={installedAddons}
              selectedVersion={selectedVersion}
              customAddonPath={customAddonPath}
              cudaApplicable={cudaApplicable}
              downloadingVariant={downloadingVariant}
              onSelectBackend={handleSelectBackend}
              onOpenDownloadSheet={() => openDownloadSheet()}
            />

            <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 text-sm font-medium w-full"
                >
                  <ChevronDown
                    className={`w-4 h-4 transition-transform ${moreOpen ? '' : '-rotate-90'}`}
                  />
                  {t('gpuAcceleration.moreOptions')}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3 space-y-4">
                <GpuInstalledList
                  gpuEnv={gpuEnv}
                  installedAddons={installedAddons}
                  updates={updates}
                  checkingUpdates={checkingUpdates}
                  downloadingVariant={downloadingVariant}
                  onCheckUpdates={() => void handleCheckUpdates()}
                  onRemoveAddon={handleRemoveAddon}
                  onOpenDownloadSheet={(version) => openDownloadSheet(version)}
                  onDownloadVulkan={() => void handleDownload('vulkan')}
                />

                <GpuCustomAddonSection
                  customAddonPath={customAddonPath}
                  onSelectCustomAddon={() => void handleSelectCustomAddon()}
                  onClearCustomAddon={() => void handleClearCustomAddon()}
                />

                <GpuDiagnosticsPanel
                  gpuEnv={gpuEnv}
                  activeBackend={activeBackend}
                  gpuMode={gpuMode}
                  selectedVersion={selectedVersion}
                  customAddonPath={customAddonPath}
                  installedAddons={installedAddons}
                  isDesktopGpuPlatform={isDesktopGpuPlatform}
                  onCopyDiagnostics={() => void handleCopyDiagnostics()}
                />

                <div className="flex items-start gap-2 p-2.5 bg-muted/50 rounded-md border">
                  <Info className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <span className="text-[11px] text-muted-foreground">
                    {t('gpuAcceleration.crashTip')}
                  </span>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {cudaApplicable && (
              <CudaDownloadSheet
                open={sheetState.open}
                onOpenChange={(open) => setSheetState((s) => ({ ...s, open }))}
                gpuEnv={gpuEnv}
                availableCudaVersions={availableCudaVersions}
                usedRemoteFallback={usedRemoteFallback}
                downloadSource={downloadSource}
                onDownloadSourceChange={handleDownloadSourceChange}
                presetVersion={sheetState.presetVersion}
                downloadingVariant={downloadingVariant}
                onConfirmDownload={handleCudaDownload}
              />
            )}
          </>
        )}

        {!isDesktopGpuPlatform && (
          <GpuDiagnosticsPanel
            gpuEnv={gpuEnv}
            activeBackend={activeBackend}
            gpuMode={gpuMode}
            selectedVersion={selectedVersion}
            customAddonPath={customAddonPath}
            installedAddons={installedAddons}
            isDesktopGpuPlatform={isDesktopGpuPlatform}
            onCopyDiagnostics={() => void handleCopyDiagnostics()}
          />
        )}
      </CardContent>
    </Card>
  );
};

export default GpuAccelerationCard;

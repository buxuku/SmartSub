import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Zap, ZapOff, Cpu, AlertTriangle, Info, Gauge } from 'lucide-react';
import type {
  AddonLoadResultInfo,
  AddonVariant,
  GpuEnvironment,
  GpuMode,
} from '../../../../types/addon';
import {
  getDefaultPackageEdition,
  getRecommendedCudaVersion,
  getRecommendationReasonText,
} from './gpuDownloadUtils';
import {
  backendDisplay,
  statusToneClasses,
  resolveActiveBackendForPlatform,
  type StatusTone,
} from './gpuUtils';

interface GpuStatusHeroProps {
  gpuEnv: GpuEnvironment;
  activeBackend: AddonLoadResultInfo | null;
  gpuMode: GpuMode;
  isDesktopGpuPlatform: boolean;
  selectedVersion: AddonVariant | null;
  customAddonPath: string | null;
  downloadingVariant: AddonVariant | null;
  upgradeSizeHint: string | null;
  onOpenDownloadSheet: () => void;
  onManageInstalled: () => void;
}

const GpuStatusHero: React.FC<GpuStatusHeroProps> = ({
  gpuEnv,
  activeBackend,
  gpuMode,
  isDesktopGpuPlatform,
  selectedVersion,
  customAddonPath,
  downloadingVariant,
  upgradeSizeHint,
  onOpenDownloadSheet,
  onManageInstalled,
}) => {
  const { t } = useTranslation('settings');

  const nvidiaRecommendation = gpuEnv.nvidia?.recommendation;
  const recommendedCudaVersion = nvidiaRecommendation?.recommendedVersion;
  const cudaApplicable = !!nvidiaRecommendation?.canUseCuda;
  const effectiveBackend = resolveActiveBackendForPlatform(
    activeBackend,
    gpuEnv,
  );
  const activeLabel = backendDisplay(effectiveBackend);
  const isCudaActive = effectiveBackend?.backend === 'cuda';

  const showUpgradeButton =
    isDesktopGpuPlatform &&
    gpuMode !== 'cpu-only' &&
    cudaApplicable &&
    !!recommendedCudaVersion &&
    !isCudaActive &&
    !(selectedVersion && selectedVersion !== 'vulkan') &&
    !customAddonPath;

  const defaultEdition = getDefaultPackageEdition(gpuEnv);
  const editionLabel =
    defaultEdition === 'full'
      ? t('gpuAcceleration.fullEdition')
      : t('gpuAcceleration.liteEdition');
  const sizeHint =
    upgradeSizeHint ??
    (defaultEdition === 'full'
      ? t('gpuAcceleration.fullEditionSizeHint')
      : t('gpuAcceleration.liteEditionSizeHint'));

  const gpuName =
    gpuEnv.gpus?.[0]?.name ||
    gpuEnv.nvidia?.gpuSupport?.gpuName ||
    t('gpuAcceleration.notDetected');

  const deriveStatus = (): { tone: StatusTone; title: string } => {
    if (gpuMode === 'cpu-only') {
      return { tone: 'gray', title: t('gpuAcceleration.statusCpuManual') };
    }
    if (!effectiveBackend) {
      if (gpuMode === 'gpu-only') {
        return {
          tone: 'neutral',
          title: t('gpuAcceleration.statusGpuOnlyPending'),
        };
      }
      return { tone: 'neutral', title: t('gpuAcceleration.statusAutoReady') };
    }
    const fallbackTone: StatusTone = gpuMode === 'auto' ? 'neutral' : 'yellow';
    if (effectiveBackend.backend === 'cpu') {
      return {
        tone: isDesktopGpuPlatform ? fallbackTone : 'gray',
        title: isDesktopGpuPlatform
          ? t('gpuAcceleration.statusFallback', { backend: 'CPU' })
          : t('gpuAcceleration.statusCpu'),
      };
    }
    if (effectiveBackend.fallback) {
      return {
        tone: fallbackTone,
        title: t('gpuAcceleration.statusFallback', { backend: activeLabel }),
      };
    }
    return {
      tone: 'green',
      title: t('gpuAcceleration.statusRunningGpu', { backend: activeLabel }),
    };
  };

  const status = deriveStatus();
  const recommendationReason = getRecommendationReasonText(
    t,
    nvidiaRecommendation?.reasonKey,
  );

  const renderStatusIcon = () => {
    if (status.tone === 'green')
      return <Zap className="w-5 h-5 text-success" />;
    if (status.tone === 'yellow')
      return <AlertTriangle className="w-5 h-5 text-warning" />;
    if (status.tone === 'neutral')
      return <Info className="w-5 h-5 text-muted-foreground" />;
    if (gpuMode === 'cpu-only')
      return <ZapOff className="w-5 h-5 text-muted-foreground" />;
    return <Cpu className="w-5 h-5 text-muted-foreground" />;
  };

  return (
    <div
      className={`rounded-lg border-2 p-4 space-y-2 ${statusToneClasses[status.tone]}`}
    >
      <div className="flex items-center gap-2">
        {renderStatusIcon()}
        <span className="font-semibold text-sm">{status.title}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {gpuName}
        {gpuEnv.nvidia?.gpuSupport?.driverVersion &&
          ` · ${t('gpuAcceleration.driver')} ${gpuEnv.nvidia.gpuSupport.driverVersion}`}
      </div>
      {status.tone === 'yellow' &&
        (effectiveBackend?.failedAttempts?.length ?? 0) > 0 && (
          <div className="text-xs text-warning">
            {effectiveBackend!.failedAttempts[0].error}
          </div>
        )}
      {status.tone !== 'green' &&
        isDesktopGpuPlatform &&
        !gpuEnv.vulkanRuntime && (
          <div className="text-xs text-muted-foreground">
            {t('gpuAcceleration.updateDriverHint')}
            {gpuEnv.platform === 'linux' &&
              ` ${t('gpuAcceleration.linuxVulkanHint')}`}
          </div>
        )}
      {showUpgradeButton && recommendedCudaVersion && (
        <div className="pt-2 border-t border-current/10 space-y-2">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <Gauge className="w-3.5 h-3.5" />
            {t('gpuAcceleration.upgradeHint', { gpu: gpuName })}
          </div>
          {recommendationReason && (
            <p className="text-xs text-muted-foreground">
              {recommendationReason}
            </p>
          )}
          <Button
            size="sm"
            className="gap-1.5"
            onClick={onOpenDownloadSheet}
            disabled={!!downloadingVariant}
          >
            <Zap className="h-4 w-4" />
            {t('gpuAcceleration.upgradeToCudaWithDetails', {
              version: recommendedCudaVersion,
              edition: editionLabel,
              sizeHint,
            })}
          </Button>
        </div>
      )}
      {isCudaActive && isDesktopGpuPlatform && (
        <div className="pt-2 border-t border-current/10">
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={onManageInstalled}
          >
            {t('gpuAcceleration.manageInstalled')} →
          </button>
        </div>
      )}
    </div>
  );
};

export default GpuStatusHero;

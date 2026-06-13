import React from 'react';
import { useTranslation } from 'next-i18next';
import { Badge } from '@/components/ui/badge';
import type {
  AddonVariant,
  CudaVersion,
  GpuEnvironment,
} from '../../../../types/addon';
import type { InstalledAddonInfo } from './types';

interface BackendOption {
  id: string;
  label: string;
  variant: AddonVariant | null;
}

interface GpuBackendSwitcherProps {
  gpuEnv: GpuEnvironment;
  installedAddons: InstalledAddonInfo[];
  selectedVersion: AddonVariant | null;
  customAddonPath: string | null;
  cudaApplicable: boolean;
  downloadingVariant: AddonVariant | null;
  onSelectBackend: (variant: AddonVariant | null) => void;
  onOpenDownloadSheet: () => void;
}

const GpuBackendSwitcher: React.FC<GpuBackendSwitcherProps> = ({
  gpuEnv,
  installedAddons,
  selectedVersion,
  customAddonPath,
  cudaApplicable,
  downloadingVariant,
  onSelectBackend,
  onOpenDownloadSheet,
}) => {
  const { t } = useTranslation('settings');

  const isVariantInstalled = (variant: AddonVariant): boolean =>
    installedAddons.some((a) => a.version === variant);

  const currentValue = customAddonPath
    ? 'custom'
    : (selectedVersion ?? 'builtin-vulkan');

  const buildOptions = (): BackendOption[] => {
    if (customAddonPath) {
      return [
        {
          id: 'custom',
          label: t('gpuAcceleration.customBackend'),
          variant: null,
        },
      ];
    }

    const options: BackendOption[] = [];
    if (gpuEnv.builtinVulkanAvailable) {
      options.push({
        id: 'builtin-vulkan',
        label: t('gpuAcceleration.vulkanBuiltin'),
        variant: null,
      });
    }
    if (isVariantInstalled('vulkan')) {
      options.push({
        id: 'vulkan',
        label: t('gpuAcceleration.vulkanUserData'),
        variant: 'vulkan',
      });
    }
    for (const addon of installedAddons) {
      if (addon.version === 'vulkan') continue;
      options.push({
        id: addon.version,
        label: `CUDA ${addon.version}`,
        variant: addon.version as CudaVersion,
      });
    }
    return options;
  };

  const options = buildOptions();
  const isBusy = !!downloadingVariant;

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">
        {t('gpuAcceleration.currentBackend')}
      </h4>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const isSelected = currentValue === opt.id;
          const isCustom = opt.id === 'custom';
          return (
            <button
              key={opt.id}
              type="button"
              disabled={isBusy || isCustom}
              onClick={() => {
                if (!isCustom) onSelectBackend(opt.variant);
              }}
              className={`px-3 py-2 rounded-lg border-2 text-sm transition-all ${
                isSelected
                  ? 'border-primary bg-primary/5 font-medium'
                  : 'border-muted hover:border-primary/50'
              } ${isCustom ? 'cursor-default' : ''}`}
            >
              {opt.label}
              {isCustom && (
                <Badge variant="outline" className="ml-1.5 text-[10px]">
                  {t('gpuAcceleration.customAddonActive')}
                </Badge>
              )}
            </button>
          );
        })}
      </div>
      {cudaApplicable && !customAddonPath && (
        <p className="text-xs text-muted-foreground">
          {t('gpuAcceleration.needCudaAcceleration')}{' '}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={onOpenDownloadSheet}
            disabled={isBusy}
          >
            {t('gpuAcceleration.downloadCudaPack')}
          </button>
        </p>
      )}
    </div>
  );
};

export default GpuBackendSwitcher;

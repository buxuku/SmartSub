import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  CheckCircle,
  RefreshCw,
  Trash2,
  X,
  ArrowLeftRight,
} from 'lucide-react';
import type {
  AddonUpdateInfo,
  AddonVariant,
  CudaVersion,
  GpuEnvironment,
} from '../../../../types/addon';
import type { InstalledAddonInfo } from './types';
import { formatSize } from './gpuUtils';

interface GpuInstalledListProps {
  gpuEnv: GpuEnvironment;
  installedAddons: InstalledAddonInfo[];
  updates: AddonUpdateInfo[];
  checkingUpdates: boolean;
  downloadingVariant: AddonVariant | null;
  onCheckUpdates: () => void;
  onRemoveAddon: (variant: AddonVariant) => void;
  onOpenDownloadSheet: (version: CudaVersion) => void;
  onDownloadVulkan: () => void;
}

const GpuInstalledList: React.FC<GpuInstalledListProps> = ({
  gpuEnv,
  installedAddons,
  updates,
  checkingUpdates,
  downloadingVariant,
  onCheckUpdates,
  onRemoveAddon,
  onOpenDownloadSheet,
  onDownloadVulkan,
}) => {
  const { t } = useTranslation('settings');

  const isVariantInstalled = (variant: AddonVariant): boolean =>
    installedAddons.some((a) => a.version === variant);

  const vulkanUpdate = updates.find(
    (u) => u.variant === 'vulkan' && u.hasUpdate,
  );
  const isBusy = !!downloadingVariant;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {t('gpuAcceleration.installedManagement')}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={onCheckUpdates}
          disabled={checkingUpdates}
        >
          <RefreshCw
            className={`w-3 h-3 mr-1 ${checkingUpdates ? 'animate-spin' : ''}`}
          />
          {t('gpuAcceleration.checkNewVersion')}
        </Button>
      </div>

      {gpuEnv.builtinVulkanAvailable && (
        <div className="flex items-center justify-between p-2 rounded-md border text-xs">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-3.5 h-3.5 text-success" />
            <span>Vulkan</span>
            <Badge variant="secondary" className="text-[10px]">
              {t('gpuAcceleration.builtin')}
            </Badge>
          </div>
          {vulkanUpdate && !isVariantInstalled('vulkan') && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px] text-warning"
              disabled={isBusy}
              onClick={onDownloadVulkan}
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              {t('gpuAcceleration.update')}
            </Button>
          )}
        </div>
      )}

      {installedAddons.map((addon) => {
        const hasUpdate = updates.find(
          (u) => u.variant === addon.version && u.hasUpdate,
        );
        const label =
          addon.version === 'vulkan' ? 'Vulkan' : `CUDA ${addon.version}`;
        const isCuda = addon.version !== 'vulkan';

        return (
          <div
            key={addon.version}
            className="flex items-center justify-between p-2 rounded-md border text-xs"
          >
            <div className="flex items-center gap-2 min-w-0">
              <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
              <span>{label}</span>
              <span className="text-muted-foreground truncate">
                v{addon.info.remoteVersion} · {formatSize(addon.info.size)}
              </span>
              {isCuda && (
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {addon.info.hasDlls
                    ? t('gpuAcceleration.fullEdition')
                    : t('gpuAcceleration.liteEdition')}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {isCuda && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px]"
                  disabled={isBusy}
                  onClick={() =>
                    onOpenDownloadSheet(addon.version as CudaVersion)
                  }
                >
                  <ArrowLeftRight className="w-3 h-3 mr-1" />
                  {t('gpuAcceleration.switchPackageType')}
                </Button>
              )}
              {hasUpdate && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px] text-warning"
                  disabled={isBusy}
                  onClick={() => {
                    if (isCuda) {
                      onOpenDownloadSheet(addon.version as CudaVersion);
                    } else {
                      onDownloadVulkan();
                    }
                  }}
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
                    <AlertDialogCancel className="gap-1.5">
                      <X className="h-4 w-4" />
                      {t('cancel')}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => onRemoveAddon(addon.version)}
                      className="gap-1.5"
                    >
                      <Trash2 className="h-4 w-4" />
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
  );
};

export default GpuInstalledList;

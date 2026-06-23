import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Download, ExternalLink, X } from 'lucide-react';
import { openUrl } from '@/lib/utils';
import type {
  AddonVariant,
  CudaVersion,
  DownloadSource,
  GpuEnvironment,
} from '../../../../types/addon';
import {
  canDownloadLiteEdition,
  editionToDownloadType,
  fetchPackageSizeHints,
  getCompatibleCudaVersions,
  getDefaultPackageEdition,
  getRecommendedCudaVersion,
  persistDownloadSource,
  getRecommendationReasonText,
} from './gpuDownloadUtils';
import { formatSize } from './gpuUtils';
import type { PackageEdition } from './types';

interface CudaDownloadSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gpuEnv: GpuEnvironment;
  availableCudaVersions: CudaVersion[];
  usedRemoteFallback: boolean;
  downloadSource: DownloadSource;
  onDownloadSourceChange: (source: DownloadSource) => void;
  presetVersion: CudaVersion | null;
  downloadingVariant: AddonVariant | null;
  onConfirmDownload: (variant: CudaVersion, type: 'node.gz' | 'tar.gz') => void;
}

const CudaDownloadSheet: React.FC<CudaDownloadSheetProps> = ({
  open,
  onOpenChange,
  gpuEnv,
  availableCudaVersions,
  usedRemoteFallback,
  downloadSource,
  onDownloadSourceChange,
  presetVersion,
  downloadingVariant,
  onConfirmDownload,
}) => {
  const { t } = useTranslation('settings');
  const recommendedVersion = getRecommendedCudaVersion(gpuEnv);
  const compatibleVersions = useMemo(
    () => getCompatibleCudaVersions(gpuEnv, availableCudaVersions),
    [gpuEnv, availableCudaVersions],
  );
  const defaultEdition = getDefaultPackageEdition(gpuEnv);
  const fallbackVersion = useMemo(
    () =>
      presetVersion ??
      recommendedVersion ??
      compatibleVersions[0] ??
      availableCudaVersions[0] ??
      '12.4.0',
    [
      presetVersion,
      recommendedVersion,
      compatibleVersions,
      availableCudaVersions,
    ],
  );

  const [selectedVersion, setSelectedVersion] =
    useState<CudaVersion>(fallbackVersion);
  const [selectedEdition, setSelectedEdition] =
    useState<PackageEdition>(defaultEdition);
  const [sizeHints, setSizeHints] = useState<{
    full: number | null;
    lite: number | null;
  }>({ full: null, lite: null });
  const [sizesLoading, setSizesLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedVersion(fallbackVersion);
    setSelectedEdition(defaultEdition);
  }, [open, fallbackVersion, defaultEdition]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSizesLoading(true);
    void fetchPackageSizeHints(selectedVersion, downloadSource)
      .then((hints) => {
        if (!cancelled) setSizeHints(hints);
      })
      .finally(() => {
        if (!cancelled) setSizesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedVersion, downloadSource]);

  const sizeLabel = (bytes: number | null, fallbackKey: string) => {
    if (sizesLoading) return t('gpuAcceleration.sizeLoading');
    return bytes ? formatSize(bytes) : t(`gpuAcceleration.${fallbackKey}`);
  };

  const reason = getRecommendationReasonText(
    t,
    gpuEnv.nvidia?.recommendation.reasonKey,
  );
  const liteAllowed = canDownloadLiteEdition(gpuEnv);
  const isBusy = !!downloadingVariant;
  const canStart = !isBusy && (selectedEdition === 'full' || liteAllowed);
  const maxCuda = gpuEnv.nvidia?.gpuSupport.maxCudaVersion;

  const handleSourceChange = (source: DownloadSource) => {
    onDownloadSourceChange(source);
    persistDownloadSource(source);
  };

  const handleConfirm = () => {
    onConfirmDownload(selectedVersion, editionToDownloadType(selectedEdition));
    onOpenChange(false);
  };

  const editionCardClass = (edition: PackageEdition, selected: boolean) =>
    `flex-1 p-3 rounded-lg border-2 text-left transition-all ${
      selected
        ? 'border-primary bg-primary/5'
        : 'border-muted hover:border-primary/50'
    } ${edition === 'lite' && !liteAllowed ? 'opacity-60' : ''}`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('gpuAcceleration.downloadSheetTitle')}</SheetTitle>
        </SheetHeader>

        <div className="space-y-5 py-4">
          {reason && (
            <div className="text-sm">
              <span className="text-muted-foreground">
                {t('gpuAcceleration.downloadSheetReason')}：
              </span>{' '}
              {reason}
            </div>
          )}

          <div className="space-y-2">
            <h4 className="text-sm font-medium">
              {t('gpuAcceleration.selectCudaVersion')}
            </h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('gpuAcceleration.cudaVersionGuide')}
              {maxCuda && (
                <span className="block mt-1">
                  {t('gpuAcceleration.maxCuda')}: {maxCuda}
                </span>
              )}
            </p>
            {usedRemoteFallback && (
              <p className="text-[11px] text-warning">
                {t('gpuAcceleration.remoteVersionsFallback')}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {compatibleVersions.map((version) => {
                const isRecommended = version === recommendedVersion;
                const isSelected = version === selectedVersion;
                return (
                  <button
                    key={version}
                    type="button"
                    disabled={isBusy}
                    onClick={() => setSelectedVersion(version)}
                    className={`min-h-[2.25rem] px-3 py-1.5 rounded-md border text-sm transition-all ${
                      isSelected
                        ? 'border-primary bg-primary/5 font-medium'
                        : 'border-muted hover:border-primary/50'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      CUDA {version}
                      {isRecommended && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] px-1 py-0"
                        >
                          {t('gpuAcceleration.recommended')}
                        </Badge>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {selectedVersion !== recommendedVersion &&
              compatibleVersions.length > 1 && (
                <p className="text-[11px] text-muted-foreground">
                  {t('gpuAcceleration.cudaVersionOlderHint')}
                </p>
              )}
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium">
              {t('gpuAcceleration.selectPackageType')}
            </h4>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => setSelectedEdition('full')}
                className={editionCardClass('full', selectedEdition === 'full')}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium">
                    {t('gpuAcceleration.fullEdition')}
                  </span>
                  {defaultEdition === 'full' && (
                    <Badge variant="secondary" className="text-[10px]">
                      {t('gpuAcceleration.recommended')}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {sizeLabel(sizeHints.full, 'fullEditionSizeHint')}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {t('gpuAcceleration.fullEditionDesc')}
                </div>
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => setSelectedEdition('lite')}
                className={editionCardClass('lite', selectedEdition === 'lite')}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium">
                    {t('gpuAcceleration.liteEdition')}
                  </span>
                  {defaultEdition === 'lite' && (
                    <Badge variant="secondary" className="text-[10px]">
                      {t('gpuAcceleration.recommended')}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {sizeLabel(sizeHints.lite, 'liteEditionSizeHint')}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {t('gpuAcceleration.liteEditionDesc')}
                </div>
              </button>
            </div>
            {selectedEdition === 'lite' && !liteAllowed && (
              <p className="text-xs text-warning">
                {t('gpuAcceleration.liteRequiresToolkit')}{' '}
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  onClick={() =>
                    openUrl('https://developer.nvidia.com/cuda-downloads')
                  }
                >
                  {t('gpuAcceleration.installCudaToolkit')}
                  <ExternalLink className="w-3 h-3" />
                </button>
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-medium">
              {t('gpuAcceleration.downloadSource')}
            </h4>
            <div className="flex gap-2">
              {(['github', 'ghproxy', 'gitcode'] as DownloadSource[]).map(
                (source) => (
                  <button
                    key={source}
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleSourceChange(source)}
                    className={`flex-1 px-3 py-2 rounded-md border text-xs transition-all ${
                      downloadSource === source
                        ? 'border-primary bg-primary/5 font-medium'
                        : 'border-muted hover:border-primary/50'
                    }`}
                  >
                    {source === 'github'
                      ? 'GitHub'
                      : source === 'gitcode'
                        ? 'GitCode'
                        : t('gpuAcceleration.ghProxy')}
                  </button>
                ),
              )}
            </div>
          </div>
        </div>

        <SheetFooter className="flex-row gap-2 sm:justify-end">
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => onOpenChange(false)}
            disabled={isBusy}
          >
            <X className="h-4 w-4" />
            {t('cancel')}
          </Button>
          <Button
            className="gap-1.5"
            disabled={!canStart}
            onClick={handleConfirm}
          >
            <Download className="h-4 w-4" />
            {t('gpuAcceleration.startDownload')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};

export default CudaDownloadSheet;

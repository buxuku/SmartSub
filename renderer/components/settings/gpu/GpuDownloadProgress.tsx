import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { RefreshCw, X } from 'lucide-react';
import type { AddonVariant, DownloadProgress } from '../../../../types/addon';
import { formatEta, formatSize } from './gpuUtils';

interface GpuDownloadProgressProps {
  downloadProgress: DownloadProgress | null;
  downloadingVariant: AddonVariant | null;
  onRetry: (variant: AddonVariant) => void;
  onCancel: () => void;
  onDismiss: () => void;
}

const GpuDownloadProgress: React.FC<GpuDownloadProgressProps> = ({
  downloadProgress,
  downloadingVariant,
  onRetry,
  onCancel,
  onDismiss,
}) => {
  const { t } = useTranslation('settings');

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
              onClick={() => onRetry(downloadingVariant)}
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              {t('gpuAcceleration.retry')}
            </Button>
          )}
          {isDownloading && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={onCancel}
            >
              <X className="h-4 w-4" />
              {t('cancel')}
            </Button>
          )}
          {isError && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={onDismiss}
            >
              <X className="h-4 w-4" />
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

export default GpuDownloadProgress;

import React, { FC } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'next-i18next';

interface DownloadDetail {
  status: string;
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
}

interface IProps {
  loading?: boolean;
  progress?: number;
  detail?: DownloadDetail | null;
  handleDownModel?: () => void;
  disabled?: boolean;
}

function formatSpeed(bytes: number): string {
  if (bytes <= 0) return '--';
  const k = 1024;
  if (bytes < k) return `${bytes.toFixed(0)} B/s`;
  if (bytes < k * k) return `${(bytes / k).toFixed(0)} KB/s`;
  return `${(bytes / (k * k)).toFixed(1)} MB/s`;
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const DownModelButton: FC<IProps> = ({
  loading,
  progress,
  detail,
  handleDownModel,
  disabled,
}) => {
  const { t } = useTranslation('common');

  if (!loading) {
    return (
      <Button
        onClick={handleDownModel}
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        disabled={disabled}
      >
        {t('download')}
      </Button>
    );
  }

  const percent = progress ? Math.min(progress * 100, 100).toFixed(1) : '0.0';
  const hasDetail = detail && detail.total > 0;

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 min-w-[220px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0 text-primary" />
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-1">
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground w-[42px] text-right">
              {percent}%
            </span>
          </div>
          {hasDetail && (
            <div className="flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
              <span className="w-[65px]">{formatSpeed(detail.speed)}</span>
              <span className="w-[40px]">{formatEta(detail.eta)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default DownModelButton;

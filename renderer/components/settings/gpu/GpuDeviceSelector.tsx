import React from 'react';
import { useTranslation } from 'next-i18next';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { GpuInfo } from '../../../../types/addon';
import {
  resolveSelectedCudaGpu,
  selectableNvidiaGpus,
} from '../../../../types/gpuDevice';

interface GpuDeviceSelectorProps {
  gpus: GpuInfo[];
  selectedDevice: string;
  restartRequired: boolean;
  onDeviceChange: (uuid: string) => void | Promise<void>;
  onRestart: () => void | Promise<void>;
}

const AUTO_VALUE = 'auto';

const GpuDeviceSelector: React.FC<GpuDeviceSelectorProps> = ({
  gpus,
  selectedDevice,
  restartRequired,
  onDeviceChange,
  onRestart,
}) => {
  const { t } = useTranslation('settings');
  const nvidiaGpus = selectableNvidiaGpus(gpus);
  const selectedGpu = resolveSelectedCudaGpu(nvidiaGpus, selectedDevice);

  // A selector adds no value on single-GPU machines unless a stored selection
  // is present and the user may need to return to automatic mode.
  if (nvidiaGpus.length <= 1 && !selectedDevice) return null;

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm">
            {t('gpuAcceleration.cudaDeviceTitle')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('gpuAcceleration.cudaDeviceDesc')}
          </p>
        </div>
        <Select
          value={selectedGpu?.uuid || AUTO_VALUE}
          onValueChange={(value) =>
            void onDeviceChange(value === AUTO_VALUE ? '' : value)
          }
        >
          <SelectTrigger className="w-[260px] max-w-[55%]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_VALUE}>
              {t('gpuAcceleration.cudaDeviceAuto')}
            </SelectItem>
            {nvidiaGpus.map((gpu) => (
              <SelectItem key={gpu.uuid} value={gpu.uuid!}>
                GPU {gpu.index}: {gpu.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {t('gpuAcceleration.cudaDeviceScope')}
      </p>

      {restartRequired && (
        <div className="flex items-center justify-between gap-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span>{t('gpuAcceleration.cudaDeviceRestartRequired')}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 text-xs"
            onClick={() => void onRestart()}
          >
            <RotateCw className="mr-1 h-3 w-3" />
            {t('gpuAcceleration.restartNow')}
          </Button>
        </div>
      )}
    </div>
  );
};

export default GpuDeviceSelector;

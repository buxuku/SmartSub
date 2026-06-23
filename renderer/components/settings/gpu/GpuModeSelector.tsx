import React from 'react';
import { useTranslation } from 'next-i18next';
import { Separator } from '@/components/ui/separator';
import type { GpuMode } from '../../../../types/addon';

interface GpuModeSelectorProps {
  gpuMode: GpuMode;
  onModeChange: (mode: GpuMode) => void;
}

const GpuModeSelector: React.FC<GpuModeSelectorProps> = ({
  gpuMode,
  onModeChange,
}) => {
  const { t } = useTranslation('settings');

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

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{t('gpuAcceleration.modeTitle')}</h4>
      <div className="grid grid-cols-3 gap-2">
        {modeOptions.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onModeChange(opt.value)}
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
      <Separator className="mt-4" />
    </div>
  );
};

export default GpuModeSelector;

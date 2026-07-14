import React from 'react';
import { useTranslation } from 'next-i18next';
import { Separator } from '@/components/ui/separator';
import { Info, Cpu } from 'lucide-react';
import type { MacAccelMode } from '../../../../types/addon';

interface MacAccelSelectorProps {
  /** Apple Silicon 才有 CoreML/Metal 可选；Intel Mac 仅展示「不支持」说明 */
  appleSilicon: boolean;
  macAccelMode: MacAccelMode;
  onModeChange: (mode: MacAccelMode) => void;
}

/**
 * macOS 转写加速方式选择（对位 win/linux 的 GpuModeSelector）。
 * auto=优先 CoreML（ANE），metal=始终 Metal GPU。
 */
const MacAccelSelector: React.FC<MacAccelSelectorProps> = ({
  appleSilicon,
  macAccelMode,
  onModeChange,
}) => {
  const { t } = useTranslation('settings');

  if (!appleSilicon) {
    return (
      <div className="flex items-start gap-2 p-2.5 bg-muted/50 rounded-md border">
        <Cpu className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <span className="text-[11px] text-muted-foreground">
          {t('gpuAcceleration.macAccelIntelNote')}
        </span>
      </div>
    );
  }

  const modeOptions: { value: MacAccelMode; label: string; desc: string }[] = [
    {
      value: 'auto',
      label: t('gpuAcceleration.macAccelAuto'),
      desc: t('gpuAcceleration.macAccelAutoDesc'),
    },
    {
      value: 'metal',
      label: t('gpuAcceleration.macAccelMetal'),
      desc: t('gpuAcceleration.macAccelMetalDesc'),
    },
  ];

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">
        {t('gpuAcceleration.macAccelTitle')}
      </h4>
      <div className="grid grid-cols-2 gap-2">
        {modeOptions.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onModeChange(opt.value)}
            className={`p-2.5 rounded-lg border-2 text-left transition-all ${
              macAccelMode === opt.value
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
      <div className="flex items-start gap-2 p-2.5 bg-muted/50 rounded-md border">
        <Info className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <span className="text-[11px] text-muted-foreground">
          {t('gpuAcceleration.macAccelTip')}
        </span>
      </div>
      <Separator className="mt-4" />
    </div>
  );
};

export default MacAccelSelector;

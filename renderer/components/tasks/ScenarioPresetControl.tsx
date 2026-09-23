import React, { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import {
  Mic,
  GraduationCap,
  Film,
  Clapperboard,
  Sliders,
  Settings2,
  Check,
  ChevronDown,
} from 'lucide-react';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import {
  SCENARIO_PRESETS,
  applyScenarioPreset,
  detectCurrentPreset,
  getScenarioPresetDef,
} from '@/lib/scenarioPresets';

interface ScenarioPresetControlProps {
  form: any;
  formData: any;
  onOpenAdvanced?: () => void;
  className?: string;
}

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Mic,
  GraduationCap,
  Film,
  Clapperboard,
  Sliders,
  Settings2,
};

export default function ScenarioPresetControl({
  form,
  formData,
  onOpenAdvanced,
  className,
}: ScenarioPresetControlProps) {
  const { t } = useTranslation('tasks');
  const [open, setOpen] = useState(false);

  const currentPresetId = detectCurrentPreset(formData);
  const currentDef = getScenarioPresetDef(currentPresetId);
  const isCustom = currentPresetId === 'custom';
  const CurrentIcon = (currentDef && ICON_MAP[currentDef.iconName]) || Sliders;
  const displayName = currentDef
    ? t(currentDef.nameKey)
    : t('presets.balanced.name');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            'h-8 w-full min-w-0 text-xs gap-1 px-2.5 font-normal justify-between',
            isCustom
              ? 'border-dashed text-muted-foreground hover:text-foreground'
              : 'border-primary/30 text-foreground bg-primary/5 hover:bg-primary/10',
            className,
          )}
        >
          <div className="flex items-center gap-1.5 min-w-0 truncate">
            <CurrentIcon
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                isCustom ? 'text-muted-foreground' : 'text-primary',
              )}
            />
            <span className="truncate">{displayName}</span>
          </div>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2 space-y-1">
        <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          {t('presets.title')}
        </div>
        {SCENARIO_PRESETS.map((preset) => {
          const isSelected = currentPresetId === preset.id;
          const Icon = ICON_MAP[preset.iconName] || Sliders;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                applyScenarioPreset(form, preset.id);
                setOpen(false);
                if (preset.id === 'custom') onOpenAdvanced?.();
              }}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-md p-2 text-left transition-colors',
                isSelected
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-muted text-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0 mt-0.5 text-primary" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">
                    {t(preset.nameKey)}
                  </span>
                  {isSelected && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                  {t(preset.descKey)}
                </p>
              </div>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

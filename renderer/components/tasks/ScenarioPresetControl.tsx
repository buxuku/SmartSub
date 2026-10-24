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
  ChevronRight,
  RotateCcw,
} from 'lucide-react';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import {
  SCENARIO_PRESETS,
  applyScenarioPreset,
  getScenarioPresetDef,
  getScenarioState,
} from '@/lib/scenarioPresets';
import type { TaskSettingsTab } from '@/components/tasks/settings/types';

interface ScenarioPresetControlProps {
  form: any;
  formData: any;
  /** Opens 更多设置; the footer links say which page they want. */
  onOpenSettings?: (tab?: TaskSettingsTab) => void;
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

/**
 * The scenario is the one way ordinary users say what the video is. Whatever they then
 * change by hand keeps the scenario's name and only adds a dot ("已调整"): the name says
 * where they started, the footer says what moved and offers the way back. 「自定义」
 * appears only after 手动调节 was chosen in 更多设置 › 专家, where nothing is a scenario any
 * more.
 */
export default function ScenarioPresetControl({
  form,
  formData,
  onOpenSettings,
  className,
}: ScenarioPresetControlProps) {
  const { t } = useTranslation('tasks');
  const [open, setOpen] = useState(false);

  const state = getScenarioState(formData);
  const currentPresetId = state.presetId;
  const currentDef = getScenarioPresetDef(currentPresetId);
  const isCustom = currentPresetId === 'custom';
  const CurrentIcon = (currentDef && ICON_MAP[currentDef.iconName]) || Sliders;
  const displayName = currentDef
    ? t(currentDef.nameKey)
    : t('presets.balanced.name');

  const openSettings = (tab: TaskSettingsTab) => {
    setOpen(false);
    onOpenSettings?.(tab);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="scenario-preset-trigger"
          title={displayName}
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
            {state.adjusted && (
              <>
                <span
                  aria-hidden="true"
                  data-testid="scenario-adjusted-dot"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                />
                <span className="sr-only">{t('presets.adjusted')}</span>
              </>
            )}
          </div>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-h-[min(34rem,var(--radix-popover-content-available-height))] overflow-y-auto p-2 space-y-1"
      >
        <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          {t('presets.title')}
        </div>
        {SCENARIO_PRESETS.filter((preset) => preset.id !== 'custom').map(
          (preset) => {
            const isSelected = currentPresetId === preset.id;
            const Icon = ICON_MAP[preset.iconName] || Sliders;
            return (
              <button
                key={preset.id}
                type="button"
                data-testid={`scenario-option-${preset.id}`}
                aria-pressed={isSelected}
                onClick={() => {
                  applyScenarioPreset(form, preset.id);
                  setOpen(false);
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
                  <p className="text-[11px] leading-snug mt-0.5 text-foreground/80">
                    {t(`presets.${preset.id}.scene`)}
                  </p>
                  <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                    {t(preset.descKey)}
                  </p>
                </div>
              </button>
            );
          },
        )}

        <div
          data-testid="scenario-footer"
          className="space-y-2 border-t px-2 pb-1 pt-2"
        >
          {isCustom && (
            <p
              data-testid="scenario-footer-custom"
              className="text-[11px] leading-snug text-muted-foreground"
            >
              {t('presets.footer.custom')}
            </p>
          )}
          {state.adjusted && (
            <div data-testid="scenario-footer-adjusted" className="space-y-1.5">
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t('presets.footer.adjusted', {
                  groups: state.groups
                    .map((group) => t(`presets.groups.${group}`))
                    .join(t('presets.footer.groupSeparator')),
                })}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="scenario-restore"
                className="h-7 w-full justify-start gap-1.5 px-2 text-xs font-normal"
                onClick={() => {
                  applyScenarioPreset(form, currentPresetId);
                  setOpen(false);
                }}
              >
                <RotateCcw className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {t('presets.footer.restore', { name: displayName })}
                </span>
              </Button>
            </div>
          )}
          <div className="flex items-center gap-1 -mx-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="scenario-open-settings"
              className="h-7 gap-0.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
              onClick={() => openSettings('common')}
            >
              {t('presets.footer.moreSettings')}
              <ChevronRight className="h-3 w-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="scenario-open-expert"
              className="h-7 gap-0.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
              onClick={() => openSettings('expert')}
            >
              {t('presets.footer.expertSettings')}
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 预设样式选择组件
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { STYLE_PRESETS } from './constants';

interface StylePresetsProps {
  activePresetId: string | null;
  onSelectPreset: (presetId: string) => void;
  disabled?: boolean;
}

export default function StylePresets({
  activePresetId,
  onSelectPreset,
  disabled = false,
}: StylePresetsProps) {
  const { t } = useTranslation('subtitleMerge');

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">
        {t('presets') || '预设样式'}
      </label>
      <div className="flex flex-wrap gap-2">
        {STYLE_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            variant={activePresetId === preset.id ? 'default' : 'outline'}
            size="sm"
            onClick={() => onSelectPreset(preset.id)}
            disabled={disabled}
            className="text-xs"
          >
            {t(preset.nameKey) || preset.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * 基础样式设置组件
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SubtitleStyle } from '../../../types/subtitleMerge';
import { FONT_LIST, FONT_SIZE_RANGE } from './constants';
import AlignmentSelector from './AlignmentSelector';

interface BasicStyleSettingsProps {
  style: SubtitleStyle;
  onUpdateStyle: (updates: Partial<SubtitleStyle>) => void;
  disabled?: boolean;
}

export default function BasicStyleSettings({
  style,
  onUpdateStyle,
  disabled = false,
}: BasicStyleSettingsProps) {
  const { t } = useTranslation('subtitleMerge');

  return (
    <div className="space-y-4">
      {/* 字体选择 */}
      <div className="space-y-2">
        <Label className="text-sm">{t('fontFamily') || '字体'}</Label>
        <Select
          value={style.fontName}
          onValueChange={(value) => onUpdateStyle({ fontName: value })}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder={t('selectFont') || '选择字体'} />
          </SelectTrigger>
          <SelectContent>
            {FONT_LIST.map((font) => (
              <SelectItem key={font.value} value={font.value}>
                <span style={{ fontFamily: font.value }}>{font.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 字号大小 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t('fontSize') || '字号'}</Label>
          <span className="text-sm text-muted-foreground">
            {style.fontSize}px
          </span>
        </div>
        <Slider
          value={[style.fontSize]}
          min={FONT_SIZE_RANGE.min}
          max={FONT_SIZE_RANGE.max}
          step={1}
          onValueChange={([value]) => onUpdateStyle({ fontSize: value })}
          disabled={disabled}
        />
      </div>

      {/* 字体颜色 */}
      <div className="space-y-2">
        <Label className="text-sm">{t('fontColor') || '字体颜色'}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="color"
            value={style.primaryColor}
            onChange={(e) => onUpdateStyle({ primaryColor: e.target.value })}
            disabled={disabled}
            className="w-12 h-9 p-1 cursor-pointer"
          />
          <Input
            type="text"
            value={style.primaryColor}
            onChange={(e) => onUpdateStyle({ primaryColor: e.target.value })}
            disabled={disabled}
            className="flex-1 font-mono text-sm"
            placeholder="#FFFFFF"
          />
        </div>
      </div>

      {/* 边框颜色 */}
      <div className="space-y-2">
        <Label className="text-sm">{t('outlineColor') || '边框颜色'}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="color"
            value={style.outlineColor}
            onChange={(e) => onUpdateStyle({ outlineColor: e.target.value })}
            disabled={disabled}
            className="w-12 h-9 p-1 cursor-pointer"
          />
          <Input
            type="text"
            value={style.outlineColor}
            onChange={(e) => onUpdateStyle({ outlineColor: e.target.value })}
            disabled={disabled}
            className="flex-1 font-mono text-sm"
            placeholder="#000000"
          />
        </div>
      </div>

      {/* 对齐位置 */}
      <div className="space-y-2">
        <Label className="text-sm">{t('position') || '位置'}</Label>
        <AlignmentSelector
          value={style.alignment}
          onChange={(value) => onUpdateStyle({ alignment: value })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

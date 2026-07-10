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
      {/* 字体 + 字号 同行 */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-sm">{t('fontFamily')}</Label>
          <Select
            value={style.fontName}
            onValueChange={(value) => onUpdateStyle({ fontName: value })}
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('selectFont')} />
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

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('fontSize')}</Label>
            <span className="text-sm text-muted-foreground">
              {style.fontSize}px
            </span>
          </div>
          <div className="flex h-9 items-center">
            <Slider
              value={[style.fontSize]}
              min={FONT_SIZE_RANGE.min}
              max={FONT_SIZE_RANGE.max}
              step={1}
              onValueChange={([value]) => onUpdateStyle({ fontSize: value })}
              disabled={disabled}
              className="w-full"
            />
          </div>
        </div>
      </div>

      {/* 字体颜色（描边/背景等效果类颜色移至「样式效果」区，按模式条件显示） */}
      <div className="space-y-2">
        <Label className="text-sm">{t('fontColor')}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="color"
            value={style.primaryColor}
            onChange={(e) => onUpdateStyle({ primaryColor: e.target.value })}
            disabled={disabled}
            className="w-10 h-9 p-1 cursor-pointer shrink-0"
          />
          <Input
            type="text"
            value={style.primaryColor}
            onChange={(e) => onUpdateStyle({ primaryColor: e.target.value })}
            disabled={disabled}
            className="min-w-0 flex-1 font-mono text-sm"
            placeholder="#FFFFFF"
          />
        </div>
      </div>

      {/* 对齐位置：标题用块级标签 + mb 与九宫格拉开（space-y 对 inline 标签/inline-grid 组合无效） */}
      <div className="pt-2">
        <Label className="mb-3 block text-sm">{t('position')}</Label>
        <AlignmentSelector
          value={style.alignment}
          onChange={(value) => onUpdateStyle({ alignment: value })}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

/**
 * 高级样式设置组件
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import type { SubtitleStyle, BorderStyle } from '../../../types/subtitleMerge';
import {
  OUTLINE_RANGE,
  SHADOW_RANGE,
  MARGIN_RANGE,
  BORDER_STYLE_OPTIONS,
} from './constants';

interface AdvancedStyleSettingsProps {
  style: SubtitleStyle;
  onUpdateStyle: (updates: Partial<SubtitleStyle>) => void;
  disabled?: boolean;
  defaultOpen?: boolean;
}

export default function AdvancedStyleSettings({
  style,
  onUpdateStyle,
  disabled = false,
  defaultOpen = false,
}: AdvancedStyleSettingsProps) {
  const { t } = useTranslation('subtitleMerge');
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex items-center justify-between w-full py-2 text-sm font-medium hover:bg-muted/50 rounded px-2 -mx-2">
        <span>{t('advancedSettings') || '高级设置'}</span>
        <ChevronDown
          className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-2">
        {/* 字体样式开关 */}
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="bold"
              checked={style.bold}
              onCheckedChange={(checked) => onUpdateStyle({ bold: checked })}
              disabled={disabled}
            />
            <Label htmlFor="bold" className="text-sm cursor-pointer">
              {t('bold') || '加粗'}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="italic"
              checked={style.italic}
              onCheckedChange={(checked) => onUpdateStyle({ italic: checked })}
              disabled={disabled}
            />
            <Label htmlFor="italic" className="text-sm cursor-pointer">
              {t('italic') || '斜体'}
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="underline"
              checked={style.underline}
              onCheckedChange={(checked) =>
                onUpdateStyle({ underline: checked })
              }
              disabled={disabled}
            />
            <Label htmlFor="underline" className="text-sm cursor-pointer">
              {t('underline') || '下划线'}
            </Label>
          </div>
        </div>

        {/* 边框样式 */}
        <div className="space-y-2">
          <Label className="text-sm">{t('borderStyle') || '边框样式'}</Label>
          <Select
            value={String(style.borderStyle)}
            onValueChange={(value) =>
              onUpdateStyle({ borderStyle: Number(value) as BorderStyle })
            }
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BORDER_STYLE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>
                  {t(option.labelKey) || option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* 边框宽度 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('outline') || '边框宽度'}</Label>
            <span className="text-sm text-muted-foreground">
              {style.outline}
            </span>
          </div>
          <Slider
            value={[style.outline]}
            min={OUTLINE_RANGE.min}
            max={OUTLINE_RANGE.max}
            step={1}
            onValueChange={([value]) => onUpdateStyle({ outline: value })}
            disabled={disabled}
          />
        </div>

        {/* 阴影距离 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('shadow') || '阴影'}</Label>
            <span className="text-sm text-muted-foreground">
              {style.shadow}
            </span>
          </div>
          <Slider
            value={[style.shadow]}
            min={SHADOW_RANGE.min}
            max={SHADOW_RANGE.max}
            step={1}
            onValueChange={([value]) => onUpdateStyle({ shadow: value })}
            disabled={disabled}
          />
        </div>

        {/* 背景颜色 */}
        <div className="space-y-2">
          <Label className="text-sm">
            {t('backgroundColor') || '背景颜色'}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              type="color"
              value={style.backColor}
              onChange={(e) => onUpdateStyle({ backColor: e.target.value })}
              disabled={disabled}
              className="w-12 h-9 p-1 cursor-pointer"
            />
            <Input
              type="text"
              value={style.backColor}
              onChange={(e) => onUpdateStyle({ backColor: e.target.value })}
              disabled={disabled}
              className="flex-1 font-mono text-sm"
              placeholder="#000000"
            />
          </div>
        </div>

        {/* 边距设置 */}
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-2">
            <Label className="text-sm">{t('marginLeft') || '左边距'}</Label>
            <Input
              type="number"
              value={style.marginL}
              onChange={(e) =>
                onUpdateStyle({ marginL: Number(e.target.value) })
              }
              min={MARGIN_RANGE.min}
              max={MARGIN_RANGE.max}
              disabled={disabled}
              className="text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">{t('marginRight') || '右边距'}</Label>
            <Input
              type="number"
              value={style.marginR}
              onChange={(e) =>
                onUpdateStyle({ marginR: Number(e.target.value) })
              }
              min={MARGIN_RANGE.min}
              max={MARGIN_RANGE.max}
              disabled={disabled}
              className="text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">
              {t('marginVertical') || '上下边距'}
            </Label>
            <Input
              type="number"
              value={style.marginV}
              onChange={(e) =>
                onUpdateStyle({ marginV: Number(e.target.value) })
              }
              min={MARGIN_RANGE.min}
              max={MARGIN_RANGE.max}
              disabled={disabled}
              className="text-sm"
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

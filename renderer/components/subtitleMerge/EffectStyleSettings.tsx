/**
 * 样式效果设置组件。
 *
 * 把 ASS 的 BorderStyle 概念翻译成小白能懂的「样式模式」二选一，
 * 并按模式只显示真正生效的参数，避免「设置了却没效果」的困惑：
 * - 描边模式（BorderStyle=1）：描边颜色/粗细、阴影距离/颜色/不透明度；
 * - 背景框模式（BorderStyle=3）：背景颜色/不透明度、背景框内边距。
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HelpHint } from '@/components/HelpHint';
import { PenLine, RectangleHorizontal } from 'lucide-react';
import type { SubtitleStyle, BorderStyle } from '../../../types/subtitleMerge';
import { OUTLINE_RANGE, SHADOW_RANGE, BACK_OPACITY_RANGE } from './constants';

interface EffectStyleSettingsProps {
  style: SubtitleStyle;
  onUpdateStyle: (updates: Partial<SubtitleStyle>) => void;
  disabled?: boolean;
}

/** 颜色选择行：色板 + hex 输入 */
function ColorField({
  label,
  hint,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label className="text-sm">{label}</Label>
        {hint && <HelpHint text={hint} />}
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-10 h-9 p-1 cursor-pointer shrink-0"
        />
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="min-w-0 flex-1 font-mono text-sm"
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}

/** 滑杆行：标签 + 当前值 + 可选说明 */
function SliderField({
  label,
  hint,
  value,
  displayValue,
  min,
  max,
  step = 1,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  displayValue?: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Label className="text-sm">{label}</Label>
          {hint && <HelpHint text={hint} />}
        </div>
        <span className="text-sm text-muted-foreground">
          {displayValue ?? value}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        disabled={disabled}
      />
    </div>
  );
}

export default function EffectStyleSettings({
  style,
  onUpdateStyle,
  disabled = false,
}: EffectStyleSettingsProps) {
  const { t } = useTranslation('subtitleMerge');
  const isBoxMode = style.borderStyle === 3;
  const backOpacity = style.backOpacity ?? BACK_OPACITY_RANGE.default;
  // 背景框模式下内边距最小 1（libass 仅在 border>0 时绘制背景框，生成端同步钳制）
  const boxPadding = Math.max(style.outline, 1);

  const modeOptions: Array<{
    value: BorderStyle;
    icon: React.ReactNode;
    title: string;
    desc: string;
  }> = [
    {
      value: 1,
      icon: <PenLine className="w-3.5 h-3.5" />,
      title: t('styleModeOutline'),
      desc: t('styleModeOutlineDesc'),
    },
    {
      value: 3,
      icon: <RectangleHorizontal className="w-3.5 h-3.5" />,
      title: t('styleModeBox'),
      desc: t('styleModeBoxDesc'),
    },
  ];

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* 样式模式：二选一卡片（与输出方式选择同一交互模式） */}
        <div className="grid grid-cols-2 gap-2">
          {modeOptions.map((option) => {
            const active = style.borderStyle === option.value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => onUpdateStyle({ borderStyle: option.value })}
                className={`rounded-md border p-2 text-left transition-colors disabled:opacity-50 ${
                  active
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent/50'
                }`}
              >
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {option.icon}
                  {option.title}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {option.desc}
                </div>
              </button>
            );
          })}
        </div>

        {isBoxMode ? (
          <>
            {/* 背景框模式：背景颜色 / 不透明度 / 内边距 */}
            <ColorField
              label={t('backgroundColor')}
              value={style.backColor}
              onChange={(v) => onUpdateStyle({ backColor: v })}
              disabled={disabled}
              placeholder="#000000"
            />
            <SliderField
              label={t('backgroundOpacity')}
              hint={t('backgroundOpacityHint')}
              value={backOpacity}
              displayValue={`${backOpacity}%`}
              min={BACK_OPACITY_RANGE.min}
              max={BACK_OPACITY_RANGE.max}
              step={BACK_OPACITY_RANGE.step}
              onChange={(v) => onUpdateStyle({ backOpacity: v })}
              disabled={disabled}
            />
            <SliderField
              label={t('boxPadding')}
              hint={t('boxPaddingHint')}
              value={boxPadding}
              min={1}
              max={OUTLINE_RANGE.max}
              onChange={(v) => onUpdateStyle({ outline: v })}
              disabled={disabled}
            />
          </>
        ) : (
          <>
            {/* 描边模式：描边颜色 / 粗细 / 阴影 */}
            <div className="grid grid-cols-2 gap-3">
              <ColorField
                label={t('outlineColor')}
                value={style.outlineColor}
                onChange={(v) => onUpdateStyle({ outlineColor: v })}
                disabled={disabled}
                placeholder="#000000"
              />
              <SliderField
                label={t('outlineWidth')}
                hint={t('outlineWidthHint')}
                value={style.outline}
                min={OUTLINE_RANGE.min}
                max={OUTLINE_RANGE.max}
                onChange={(v) => onUpdateStyle({ outline: v })}
                disabled={disabled}
              />
            </div>
            <SliderField
              label={t('shadow')}
              hint={t('shadowHint')}
              value={style.shadow}
              min={SHADOW_RANGE.min}
              max={SHADOW_RANGE.max}
              onChange={(v) => onUpdateStyle({ shadow: v })}
              disabled={disabled}
            />
            {style.shadow > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <ColorField
                  label={t('shadowColor')}
                  value={style.backColor}
                  onChange={(v) => onUpdateStyle({ backColor: v })}
                  disabled={disabled}
                  placeholder="#000000"
                />
                <SliderField
                  label={t('shadowOpacity')}
                  value={backOpacity}
                  displayValue={`${backOpacity}%`}
                  min={BACK_OPACITY_RANGE.min}
                  max={BACK_OPACITY_RANGE.max}
                  step={BACK_OPACITY_RANGE.step}
                  onChange={(v) => onUpdateStyle({ backOpacity: v })}
                  disabled={disabled}
                />
              </div>
            )}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

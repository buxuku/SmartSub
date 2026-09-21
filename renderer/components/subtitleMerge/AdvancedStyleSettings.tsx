/**
 * 高级样式设置组件（低频参数：文字修饰、边距）。
 * 描边/背景框等效果类参数已移至 EffectStyleSettings，按样式模式条件显示。
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { TooltipProvider } from '@/components/ui/tooltip';
import { HelpHint } from '@/components/HelpHint';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ASS_PLAY_RES_Y, subtitleAnchor } from '../../../types/subtitleCanvas';
import type { SubtitleStyle } from '../../../types/subtitleMerge';
import { MARGIN_RANGE } from './constants';
import { subtitleGlow } from '../../../types/subtitleAppearance';
import { subtitleColorSwatch } from '../../../types/subtitleColor';

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
    <TooltipProvider>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="flex items-center justify-between w-full py-2 hover:bg-muted/50 rounded px-2 -mx-2">
          <span className="label-caps">{t('advancedSettings')}</span>
          <ChevronDown
            className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="subtitle-highlight-terms">
              {t('highlightTerms')}
            </Label>
            <Input
              id="subtitle-highlight-terms"
              value={(style.highlightTerms || []).join(',')}
              disabled={disabled}
              onChange={(event) =>
                onUpdateStyle({ highlightTerms: event.target.value.split(',') })
              }
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="subtitle-highlight-color" className="text-xs">
                  {t('highlightColor')}
                </Label>
                <Input
                  id="subtitle-highlight-color"
                  type="color"
                  value={subtitleColorSwatch(style.highlightColor || '#FFFF00')}
                  disabled={disabled}
                  onChange={(event) =>
                    onUpdateStyle({ highlightColor: event.target.value })
                  }
                  className="h-8 p-1"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="subtitle-glow" className="text-xs">
                  {t('outerGlow')}
                </Label>
                <Input
                  id="subtitle-glow"
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  value={subtitleGlow(style)}
                  disabled={disabled}
                  onChange={(event) => {
                    if (Number.isFinite(event.target.valueAsNumber))
                      onUpdateStyle({
                        glow: Math.max(
                          0,
                          Math.min(10, event.target.valueAsNumber),
                        ),
                      });
                  }}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="subtitle-glow-color" className="flex-1 text-xs">
                {t('glowColor')}
              </Label>
              <Input
                id="subtitle-glow-color"
                type="color"
                value={subtitleColorSwatch(style.glowColor || '#FFFFFF')}
                disabled={disabled || !subtitleGlow(style)}
                className="h-8 w-10 p-1"
                onChange={(event) =>
                  onUpdateStyle({ glowColor: event.target.value })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="subtitle-second-line"
                checked={Boolean(style.secondLineColor)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onUpdateStyle({
                    secondLineColor: checked ? '#FFFFFF' : undefined,
                  })
                }
              />
              <Label htmlFor="subtitle-second-line" className="flex-1 text-xs">
                {t('secondLineColor')}
              </Label>
              <Input
                aria-label={t('secondLineColor')}
                type="color"
                value={subtitleColorSwatch(style.secondLineColor || '#FFFFFF')}
                disabled={disabled || !style.secondLineColor}
                className="h-8 w-10 p-1"
                onChange={(event) =>
                  onUpdateStyle({ secondLineColor: event.target.value })
                }
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="subtitle-position-y" className="flex-1 text-sm">
              {t('canvas.positionY')}
            </Label>
            <Input
              id="subtitle-position-y"
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={Number(
                ((subtitleAnchor(style).y / ASS_PLAY_RES_Y) * 100).toFixed(3),
              )}
              disabled={disabled}
              className="w-24"
              onChange={(event) => {
                const value = event.target.valueAsNumber;
                if (Number.isFinite(value))
                  onUpdateStyle({
                    positionY: Math.max(0, Math.min(100, value)),
                  });
              }}
            />
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('canvas.resetPosition')}
              title={t('canvas.resetPosition')}
              disabled={disabled || style.positionY === undefined}
              onClick={() =>
                onUpdateStyle({
                  positionY: undefined,
                  positionReferenceY: undefined,
                })
              }
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
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
                {t('bold')}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="italic"
                checked={style.italic}
                onCheckedChange={(checked) =>
                  onUpdateStyle({ italic: checked })
                }
                disabled={disabled}
              />
              <Label htmlFor="italic" className="text-sm cursor-pointer">
                {t('italic')}
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
                {t('underline')}
              </Label>
            </div>
          </div>

          {/* 边距设置 */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label className="text-sm">{t('margins')}</Label>
              <HelpHint text={t('marginsHint')} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  {t('marginLeft')}
                </Label>
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
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  {t('marginRight')}
                </Label>
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
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  {t('marginVertical')}
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
          </div>
        </CollapsibleContent>
      </Collapsible>
    </TooltipProvider>
  );
}

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
import { ChevronDown } from 'lucide-react';
import type { SubtitleStyle } from '../../../types/subtitleMerge';
import { MARGIN_RANGE } from './constants';

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

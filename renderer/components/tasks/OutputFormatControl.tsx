import React, { useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FileText, ChevronDown } from 'lucide-react';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';
import {
  SUBTITLE_OUTPUT_FORMATS,
  resolveSubtitleOutputFormats,
  type SubtitleOutputFormat,
} from '../../../types/subtitleOutput';
import type { TaskTypeDef } from 'lib/taskTypes';

interface OutputFormatControlProps {
  form: any;
  formData: any;
  typeDef: TaskTypeDef;
}

export default function OutputFormatControl({
  form,
  formData,
  typeDef,
}: OutputFormatControlProps) {
  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');
  const [open, setOpen] = useState(false);

  const selectedFormats = resolveSubtitleOutputFormats(formData);

  const toggleFormat = (format: SubtitleOutputFormat) => {
    let nextFormats: SubtitleOutputFormat[];
    if (selectedFormats.includes(format)) {
      if (selectedFormats.length <= 1) return;
      nextFormats = selectedFormats.filter((f) => f !== format);
    } else {
      nextFormats = [...selectedFormats, format];
    }
    form.setValue('subtitleOutputFormats', nextFormats, { shouldDirty: true });
    form.setValue('subtitleOutputFormat', nextFormats[0], {
      shouldDirty: true,
    });
  };

  const formatSummary = selectedFormats.map((f) => f.toUpperCase()).join(', ');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={tHome('subtitleOutputFormat')}
          className="h-8 text-xs gap-1.5 px-2.5 font-normal max-w-[190px] justify-between"
        >
          <div className="flex items-center gap-1.5 truncate">
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{formatSummary}</span>
          </div>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-3">
        {/* 字幕输出格式 */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">
            {t('configBar.format')}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {SUBTITLE_OUTPUT_FORMATS.map((format) => {
              const isChecked = selectedFormats.includes(format);
              return (
                <Badge
                  key={format}
                  variant={isChecked ? 'default' : 'outline'}
                  className={cn(
                    'cursor-pointer text-xs uppercase px-2 py-0.5 select-none transition-colors',
                    isChecked
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:border-foreground/40',
                  )}
                  onClick={() => toggleFormat(format)}
                >
                  {format}
                </Badge>
              );
            })}
          </div>
        </div>

        {/* 双语排版样式 */}
        {typeDef.hasTranslate && (
          <div className="space-y-1.5 pt-2 border-t border-border">
            <label className="text-xs font-medium text-foreground">
              {t('configBar.style')}
            </label>
            <Select
              value={formData.translateContent || 'sourceAndTranslate'}
              onValueChange={(v) =>
                form.setValue('translateContent', v, { shouldDirty: true })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sourceAndTranslate">
                  {tHome('sourceAndTranslate')}
                </SelectItem>
                <SelectItem value="translateAndSource">
                  {tHome('translateAndSource')}
                </SelectItem>
                <SelectItem value="onlyTranslate">
                  {tHome('onlyOutputTranslationSubtitle')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {/* 内封软字幕 */}
        {typeDef.needsModel && (
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div className="space-y-0.5">
              <span className="text-xs font-medium text-foreground">
                {t('configBar.embeddedSubtitles')}
              </span>
              <p className="text-[10px] text-muted-foreground">
                {t('configBar.embeddedSubtitlesTip', {
                  defaultValue: '封装进视频作为独立可切换字幕轨',
                })}
              </p>
            </div>
            <Switch
              checked={formData.useEmbeddedSubtitles !== false}
              onCheckedChange={(checked) =>
                form.setValue('useEmbeddedSubtitles', checked, {
                  shouldDirty: true,
                })
              }
              aria-label={t('configBar.embeddedSubtitles')}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

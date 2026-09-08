import React from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import {
  SUBTITLE_OUTPUT_FORMATS,
  resolveSubtitleOutputFormats,
  type SubtitleOutputConfig,
  type SubtitleOutputFormat,
} from '../../../types/subtitleOutput';

export default function SubtitleFormatSelect({
  config,
  onChange,
  compact = false,
}: {
  config: SubtitleOutputConfig;
  onChange: (formats: SubtitleOutputFormat[]) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation('home');
  const selected = resolveSubtitleOutputFormats(config);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={t('subtitleOutputFormat')}
          className={
            compact
              ? 'h-8 w-[200px] max-w-full justify-between gap-1 px-2 text-xs'
              : 'w-full justify-between gap-2'
          }
        >
          <span className="min-w-0 truncate">
            {selected
              .map((format) => format.toUpperCase())
              .join(compact ? ', ' : ' + ')}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-56 max-w-[calc(100vw-2rem)]"
      >
        {SUBTITLE_OUTPUT_FORMATS.map((format) => (
          <DropdownMenuCheckboxItem
            key={format}
            checked={selected.includes(format)}
            disabled={selected.length === 1 && selected.includes(format)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onChange(
                SUBTITLE_OUTPUT_FORMATS.filter((item) =>
                  item === format ? checked : selected.includes(item),
                ),
              )
            }
          >
            {t(`format_${format}`)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

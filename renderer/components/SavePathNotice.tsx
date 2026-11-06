import React from 'react';
import { CircleHelp } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useTranslation } from 'next-i18next';

const SavePathNotice = () => {
  const { t } = useTranslation('common');
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t('pathConfigTitle')}
        className="inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <CircleHelp className="h-3.5 w-3.5" />
      </PopoverTrigger>
      {/* 600px 的示例表在窄窗口里会比窗口还宽；留出两侧各 1rem 的边距 */}
      <PopoverContent className="w-[600px] max-w-[calc(100vw-2rem)]">
        <div className="grid gap-4">
          <div className="space-y-2">
            <h4 className="font-medium leading-none">{t('pathConfigTitle')}</h4>
            <p className="text-sm text-muted-foreground">
              {t('pathConfigDesc')}
            </p>
          </div>
          <div
            className="grid gap-2"
            dangerouslySetInnerHTML={{ __html: t('pathConfigDemo') }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default SavePathNotice;

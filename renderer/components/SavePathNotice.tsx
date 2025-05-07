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
      <PopoverTrigger>
        <CircleHelp className="size-4 ml-2" />
      </PopoverTrigger>
      <PopoverContent className="w-[600px]">
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

import React, { FC, useState } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslation } from 'next-i18next';

interface IProps {
  modelsInstalled?: string[];
}

const Models = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectPrimitive.SelectProps & IProps
>((props, ref) => {
  const { t } = useTranslation('common');

  return (
    <Select {...props}>
      <SelectTrigger className="items-start" id="model" ref={ref}>
        <SelectValue placeholder={t('pleaseSelect')} />
      </SelectTrigger>
      <SelectContent>
        {props?.modelsInstalled?.length > 0 ? (
          props?.modelsInstalled.map((model) => (
            <SelectItem value={model.toLowerCase()} key={model}>
              {model}
            </SelectItem>
          ))
        ) : (
          <SelectItem value="no-models" disabled>
            {t('noModelsInstalled')}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
});

Models.displayName = 'Models';

export default Models;

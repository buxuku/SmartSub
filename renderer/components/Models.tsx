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
import { models } from 'lib/utils';

interface IProps {
  modelsInstalled?: string[];
  fasterWhisperModelsInstalled?: string[];
  transcriptionEngine?: 'builtin' | 'fasterWhisper' | 'localCli';
  useLocalWhisper?: boolean;
}

const Models = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectPrimitive.SelectProps & IProps
>((props, ref) => {
  const { t } = useTranslation('common');

  const engine =
    props.transcriptionEngine ??
    (props.useLocalWhisper ? 'localCli' : 'builtin');

  const getAvailableModels = () => {
    if (engine === 'fasterWhisper') {
      return props.fasterWhisperModelsInstalled || [];
    }
    if (engine === 'localCli') {
      return models.map((model) => model.name);
    }
    return props.modelsInstalled || [];
  };

  const availableModels = getAvailableModels();

  return (
    <Select {...props}>
      <SelectTrigger className="items-start" id="model" ref={ref}>
        <SelectValue placeholder={t('pleaseSelect')} />
      </SelectTrigger>
      <SelectContent>
        {availableModels.length > 0 ? (
          availableModels.map((model) => (
            <SelectItem value={model.toLowerCase()} key={model}>
              {model}
            </SelectItem>
          ))
        ) : (
          <SelectItem value="no-models" disabled>
            {engine === 'localCli'
              ? t('noModelsAvailable')
              : t('noModelsInstalled')}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
});

Models.displayName = 'Models';

export default Models;

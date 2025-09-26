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
  useLocalWhisper?: boolean;
}

const Models = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectPrimitive.SelectProps & IProps
>((props, ref) => {
  const { t } = useTranslation('common');

  // 根据是否使用内置 whisper 决定显示的模型列表
  const getAvailableModels = () => {
    if (props.useLocalWhisper) {
      // 使用内置 whisper 时，显示所有可用模型
      return models.map((model) => model.name);
    } else {
      // 不使用内置 whisper 时，只显示已下载的模型
      return props?.modelsInstalled || [];
    }
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
            {props.useLocalWhisper
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

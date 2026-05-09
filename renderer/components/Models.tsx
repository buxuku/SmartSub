import React from 'react';
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
import {
  apiTranscriptionModels,
  reazonSpeechModels,
  type TranscriptionProviderId,
} from '../../types';

interface IProps {
  modelsInstalled?: string[];
  useLocalWhisper?: boolean;
  transcriptionProvider?: TranscriptionProviderId;
}

type AvailableModel = {
  value: string;
  label: string;
};

const Models = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectPrimitive.SelectProps & IProps
>((props, ref) => {
  const { t } = useTranslation('common');
  const {
    modelsInstalled = [],
    useLocalWhisper = false,
    transcriptionProvider = 'builtin-whisper',
    ...selectProps
  } = props;
  const [openRouterRemoteModels, setOpenRouterRemoteModels] = React.useState<
    string[]
  >([]);

  React.useEffect(() => {
    let isMounted = true;

    if (transcriptionProvider !== 'openrouter') {
      setOpenRouterRemoteModels([]);
      return () => {
        isMounted = false;
      };
    }

    if (typeof window === 'undefined' || !window?.ipc?.invoke) {
      return () => {
        isMounted = false;
      };
    }

    window.ipc
      .invoke('getOpenRouterTranscriptionModels')
      .then((result) => {
        if (!isMounted || !result?.success || !Array.isArray(result.data)) {
          return;
        }
        setOpenRouterRemoteModels(result.data);
      })
      .catch(() => {
        if (isMounted) setOpenRouterRemoteModels([]);
      });

    return () => {
      isMounted = false;
    };
  }, [transcriptionProvider]);

  // 根据是否使用内置 whisper 决定显示的模型列表
  const getAvailableModels = (): AvailableModel[] => {
    if (transcriptionProvider === 'openrouter') {
      const modelMap = new Map(
        apiTranscriptionModels.map((model) => [
          model.id,
          {
            value: model.id,
            label: model.name,
          },
        ]),
      );

      for (const model of openRouterRemoteModels) {
        if (!modelMap.has(model)) {
          modelMap.set(model, { value: model, label: model });
        }
      }

      const availableModels: AvailableModel[] = [];
      modelMap.forEach((model) => availableModels.push(model));
      return availableModels;
    }

    if (transcriptionProvider === 'reazonspeech-k2') {
      const installed = new Set(
        modelsInstalled.map((model) => model.toLowerCase()),
      );
      return reazonSpeechModels
        .filter((model) => installed.has(model.id.toLowerCase()))
        .map((model) => ({
          value: model.id,
          label: model.name,
        }));
    }

    if (transcriptionProvider === 'local-whisper-command') {
      return models.map((model) => ({
        value: model.name.toLowerCase(),
        label: model.name,
      }));
    }

    const reazonIds = new Set(
      reazonSpeechModels.map((model) => model.id.toLowerCase()),
    );
    return modelsInstalled
      .filter((model) => !reazonIds.has(model.toLowerCase()))
      .map((model) => ({
        value: model.toLowerCase(),
        label: model,
      }));
  };

  const availableModels = getAvailableModels();
  const noModelsMessage =
    transcriptionProvider === 'local-whisper-command'
      ? t('noModelsAvailable')
      : t('noModelsInstalled');

  return (
    <Select {...selectProps}>
      <SelectTrigger className="items-start" id="model" ref={ref}>
        <SelectValue placeholder={t('pleaseSelect')} />
      </SelectTrigger>
      <SelectContent>
        {availableModels.length > 0 ? (
          availableModels.map((model) => (
            <SelectItem value={model.value} key={model.value}>
              {model.label}
            </SelectItem>
          ))
        ) : (
          <SelectItem value="no-models" disabled>
            {noModelsMessage}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
});

Models.displayName = 'Models';

export default Models;

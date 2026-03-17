import React, { useEffect, useState, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff, Search, Check, Settings2 } from 'lucide-react';
import { ProviderField } from '../../types';
import { useTranslation } from 'next-i18next';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Command,
  CommandInput,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CustomParameterEditor } from './CustomParameterEditor';
import axios from 'axios';

interface ProviderFormProps {
  fields: ProviderField[];
  values: Record<string, any>;
  onChange: (key: string, value: string | boolean | number) => void;
  showPassword: Record<string, boolean>;
  onTogglePassword: (key: string) => void;
  providerId?: string;
}

export const ProviderForm: React.FC<ProviderFormProps> = ({
  fields,
  values,
  onChange,
  showPassword,
  onTogglePassword,
  providerId = '',
}) => {
  const { t } = useTranslation('translateControl');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [openaiCompatModels, setOpenaiCompatModels] = useState<
    Record<string, string[]>
  >({});
  const apiKeyRef = useRef<HTMLInputElement>(null);

  const OPENAI_COMPAT_PROVIDERS: Record<
    string,
    {
      params?: Record<string, string>;
      fallbackModels?: string[];
    }
  > = {
    DeerAPI: { fallbackModels: ['gpt-3.5-turbo', 'gpt-4'] },
    deepseek: {
      fallbackModels: ['deepseek-chat', 'deepseek-reasoner'],
    },
    siliconflow: {
      params: { sub_type: 'chat' },
      fallbackModels: [
        'deepseek-ai/DeepSeek-V3',
        'Qwen/Qwen2.5-7B-Instruct',
        'THUDM/glm-4-9b-chat',
      ],
    },
    qwen: {
      fallbackModels: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    },
  };

  const fetchOllamaModels = async (apiUrl: string) => {
    try {
      const baseUrl = apiUrl.split('/api/')[0];
      const response = await axios.get(`${baseUrl}/api/tags`);
      if (response.data?.models) {
        setOllamaModels(response.data.models.map((model) => model.name));
      }
    } catch (error) {
      console.error('Failed to fetch Ollama models:', error);
      setOllamaModels(['llama2', 'mistral', 'gemma']);
    }
  };

  const fetchOpenAICompatModels = async (
    providerType: string,
    apiUrl: string,
    apiKey: string,
  ) => {
    if (!apiUrl || !apiKey) return;
    const config = OPENAI_COMPAT_PROVIDERS[providerType];
    if (!config) return;

    try {
      const baseUrl = apiUrl.replace(/\/+$/, '');
      const response = await axios.get(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        ...(config.params && { params: config.params }),
      });
      if (response.data?.data) {
        const models = response.data.data.map((model) => model.id);
        setOpenaiCompatModels((prev) => ({ ...prev, [providerType]: models }));
      }
    } catch (error) {
      console.error(`Failed to fetch ${providerType} models:`, error);
      if (config.fallbackModels) {
        setOpenaiCompatModels((prev) => ({
          ...prev,
          [providerType]: config.fallbackModels!,
        }));
      }
    }
  };

  const handleApiKeyBlur = () => {
    if (
      OPENAI_COMPAT_PROVIDERS[values.type] &&
      values.apiKey &&
      values.apiUrl
    ) {
      fetchOpenAICompatModels(values.type, values.apiUrl, values.apiKey);
    }
  };

  useEffect(() => {
    const hasModelField = fields.some((f) => f.key === 'modelName');
    if (!hasModelField) return;

    if (values.type === 'ollama' && values.apiUrl) {
      fetchOllamaModels(values.apiUrl);
    } else if (
      OPENAI_COMPAT_PROVIDERS[values.type] &&
      values.apiKey &&
      values.apiUrl
    ) {
      fetchOpenAICompatModels(values.type, values.apiUrl, values.apiKey);
    }
  }, [fields, values.type, values.apiUrl]);

  // 可搜索的下拉选择框组件
  const SearchableSelect = ({
    value,
    onChange,
    options,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: string[];
    placeholder?: string;
  }) => {
    const [open, setOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');

    // 根据搜索词过滤选项
    const filteredOptions =
      searchQuery === ''
        ? options
        : options.filter((option) =>
            option.toLowerCase().includes(searchQuery.toLowerCase()),
          );

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
          >
            {value ? value : placeholder || t('selectOption')}
            <Search className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-full p-0" align="start">
          <Command>
            <CommandInput
              placeholder={t('searchModel')}
              value={searchQuery}
              onValueChange={setSearchQuery}
              className="h-9"
            />
            <CommandEmpty>{t('noMatchingModels')}</CommandEmpty>
            <CommandGroup className="max-h-60 overflow-auto">
              {filteredOptions.map((option) => (
                <CommandItem
                  key={option}
                  value={option}
                  onSelect={(currentValue) => {
                    onChange(currentValue);
                    setOpen(false);
                    setSearchQuery('');
                  }}
                  className="flex items-center"
                >
                  {option}
                  {value === option && (
                    <Check className="ml-auto h-4 w-4 opacity-100" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </Command>
        </PopoverContent>
      </Popover>
    );
  };

  const renderField = (field: ProviderField) => {
    const value = values[field.key] ?? field.defaultValue ?? '';
    switch (field.type) {
      case 'switch':
        return (
          <Switch
            className="ml-2 -mt-4"
            checked={!!value}
            onCheckedChange={(checked) => onChange(field.key, checked)}
          />
        );

      case 'number':
        return (
          <Input
            type="number"
            value={value}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder}
          />
        );

      case 'textarea':
        return (
          <Textarea
            value={value}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder}
            rows={3}
          />
        );

      case 'password':
        return (
          <div className="flex items-center">
            <Input
              type={showPassword[field.key] ? 'text' : 'password'}
              value={value}
              onChange={(e) => onChange(field.key, e.target.value)}
              placeholder={field.placeholder}
              className="mr-2"
              ref={field.key === 'apiKey' ? apiKeyRef : null}
              onBlur={field.key === 'apiKey' ? handleApiKeyBlur : undefined}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onTogglePassword(field.key)}
            >
              {showPassword[field.key] ? (
                <EyeOff size={16} />
              ) : (
                <Eye size={16} />
              )}
            </Button>
          </div>
        );

      case 'select':
        // 根据不同的提供商选择对应的模型列表
        let options: string[] = [];

        if (field.key === 'modelName') {
          if (values.type === 'ollama' && ollamaModels.length > 0) {
            options = ollamaModels;
          } else if (openaiCompatModels[values.type]?.length > 0) {
            options = openaiCompatModels[values.type];
          } else {
            options = field.options || [];
          }

          // 对于模型名称字段，使用可搜索的下拉选择框
          return (
            <SearchableSelect
              value={value}
              onChange={(value) => onChange(field.key, value)}
              options={options}
              placeholder={field.placeholder}
            />
          );
        } else {
          options = field.options || [];

          // 对于其他select字段，使用普通下拉选择框
          return (
            <Select
              value={value}
              onValueChange={(value) => onChange(field.key, value)}
            >
              <SelectTrigger>
                <SelectValue placeholder={field.placeholder} />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        }

      default:
        return (
          <Input
            type={field.type}
            value={value || ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder}
          />
        );
    }
  };

  return (
    <div className="grid gap-4">
      {fields.map((field) => {
        return (
          <div key={field.key} className="space-y-2">
            <label className="text-sm font-medium">
              {t(field.label)}
              {field.required && <span className="text-red-500">*</span>}
            </label>
            {renderField(field)}
            {field.tips && (
              <p
                className="text-xs text-gray-500"
                dangerouslySetInnerHTML={{ __html: t(field.tips) }}
                onClick={(e) => {
                  const target = e.target as HTMLElement;
                  if (target.tagName === 'A') {
                    e.preventDefault();
                    const url = target.getAttribute('href');
                    if (url) {
                      window.ipc.send('openUrl', url);
                    }
                  }
                }}
              ></p>
            )}
          </div>
        );
      })}

      {/* Custom Parameter Editor Section */}
      {providerId && (
        <div className="space-y-2 pt-4 border-t">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">
              {t('customParameters')}
            </label>
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-2"
                >
                  <Settings2 className="h-4 w-4" />
                  {t('configureParameters')}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-4xl max-h-[80vh] overflow-auto">
                <DialogHeader>
                  <DialogTitle>
                    {t('customParameterConfiguration')} - {values.name}
                  </DialogTitle>
                  <DialogDescription>
                    {t('customParametersTip')}
                  </DialogDescription>
                </DialogHeader>
                <CustomParameterEditor providerId={providerId} />
              </DialogContent>
            </Dialog>
          </div>
          <p className="text-xs text-gray-500">{t('customParametersTip')}</p>
        </div>
      )}
    </div>
  );
};

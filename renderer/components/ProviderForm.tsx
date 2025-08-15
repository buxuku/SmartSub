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
  const [deerApiModels, setDeerApiModels] = useState<string[]>([]);
  const apiKeyRef = useRef<HTMLInputElement>(null);

  // 获取Ollama模型列表
  const fetchOllamaModels = async (apiUrl: string) => {
    try {
      const baseUrl = apiUrl.split('/api/')[0];
      const response = await axios.get(`${baseUrl}/api/tags`);
      if (response.data && response.data.models) {
        const models = response.data.models.map((model) => model.name);
        setOllamaModels(models);
      }
    } catch (error) {
      console.error('Failed to fetch Ollama models:', error);
      // 如果获取失败，设置一个默认模型列表
      setOllamaModels(['llama2', 'mistral', 'gemma']);
    }
  };

  // 获取DeerAPI模型列表
  const fetchDeerApiModels = async (apiUrl: string, apiKey: string) => {
    if (!apiUrl || !apiKey) return;

    try {
      const response = await axios.get(`${apiUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (response.data && response.data.data) {
        const models = response.data.data.map((model) => model.id);
        setDeerApiModels(models);
      }
    } catch (error) {
      console.error('Failed to fetch DeerAPI models:', error);
      // 如果获取失败，设置一个默认模型列表
      setDeerApiModels(['gpt-3.5-turbo', 'gpt-4']);
    }
  };

  // 处理API Key输入框失去焦点事件
  const handleApiKeyBlur = () => {
    if (values.type === 'DeerAPI' && values.apiKey && values.apiUrl) {
      fetchDeerApiModels(values.apiUrl, values.apiKey);
    }
  };

  useEffect(() => {
    // 检查是否是Ollama配置页面
    const isOllamaProvider = fields.some(
      (field) => field.key === 'modelName' && values.type === 'ollama',
    );

    if (isOllamaProvider && values.apiUrl) {
      fetchOllamaModels(values.apiUrl);
    }

    // 检查是否是DeerAPI配置页面，且已有API Key
    const isDeerApiProvider = fields.some(
      (field) => field.key === 'modelName' && values.type === 'DeerAPI',
    );

    if (isDeerApiProvider && values.apiKey && values.apiUrl) {
      fetchDeerApiModels(values.apiUrl, values.apiKey);
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
    const value = values[field.key] ?? (field.defaultValue || '');
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
          } else if (values.type === 'DeerAPI' && deerApiModels.length > 0) {
            options = deerApiModels;
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

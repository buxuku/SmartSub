import React, { useEffect, useState, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Eye,
  EyeOff,
  Search,
  Check,
  Settings2,
  ChevronDown,
} from 'lucide-react';
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { CustomParameterEditor } from './CustomParameterEditor';
import { PROVIDER_ADVANCED_FIELD_KEYS } from 'lib/providerPanelUtils';
import { cn } from 'lib/utils';
import axios from 'axios';

interface ProviderFormProps {
  fields: ProviderField[];
  values: Record<string, any>;
  onChange: (key: string, value: string | boolean | number) => void;
  showPassword: Record<string, boolean>;
  onTogglePassword: (key: string) => void;
  providerId?: string;
  autoFocusField?: string | null;
}

export const ProviderForm: React.FC<ProviderFormProps> = ({
  fields,
  values,
  onChange,
  showPassword,
  onTogglePassword,
  providerId = '',
  autoFocusField = null,
}) => {
  const { t } = useTranslation('translateControl');
  const fieldPlaceholder = (key?: string) =>
    key ? t(key, { defaultValue: key }) : undefined;
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [openaiCompatModels, setOpenaiCompatModels] = useState<
    Record<string, string[]>
  >({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const didAutoFocus = useRef(false);

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

  const basicFields = fields.filter(
    (f) => !PROVIDER_ADVANCED_FIELD_KEYS.has(f.key),
  );
  const advancedFields = fields.filter((f) =>
    PROVIDER_ADVANCED_FIELD_KEYS.has(f.key),
  );

  useEffect(() => {
    didAutoFocus.current = false;
  }, [providerId, autoFocusField]);

  useEffect(() => {
    if (!autoFocusField || didAutoFocus.current) return;
    const el = document.getElementById(
      `provider-field-${providerId}-${autoFocusField}`,
    ) as HTMLInputElement | null;
    if (el) {
      el.focus();
      didAutoFocus.current = true;
    }
  }, [autoFocusField, providerId, fields]);

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

  const SearchableSelect = ({
    value,
    onChange: onSelectChange,
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
                    onSelectChange(currentValue);
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

  const fieldDomId = (key: string) => `provider-field-${providerId}-${key}`;

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
            id={fieldDomId(field.key)}
            type="number"
            step={field.step}
            value={value}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={fieldPlaceholder(field.placeholder)}
          />
        );

      case 'textarea':
        return (
          <Textarea
            id={fieldDomId(field.key)}
            value={value}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={fieldPlaceholder(field.placeholder)}
            rows={3}
          />
        );

      case 'password':
        return (
          <div className="flex items-center">
            <Input
              id={fieldDomId(field.key)}
              type={showPassword[field.key] ? 'text' : 'password'}
              value={value}
              onChange={(e) => onChange(field.key, e.target.value)}
              placeholder={fieldPlaceholder(field.placeholder)}
              className="mr-2 font-mono"
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
        let options: string[] = [];

        if (field.key === 'modelName') {
          if (values.type === 'ollama' && ollamaModels.length > 0) {
            options = ollamaModels;
          } else if (openaiCompatModels[values.type]?.length > 0) {
            options = openaiCompatModels[values.type];
          } else {
            options = field.options || [];
          }

          return (
            <SearchableSelect
              value={value}
              onChange={(v) => onChange(field.key, v)}
              options={options}
              placeholder={fieldPlaceholder(field.placeholder)}
            />
          );
        }
        options = field.options || [];
        return (
          <Select value={value} onValueChange={(v) => onChange(field.key, v)}>
            <SelectTrigger>
              <SelectValue placeholder={fieldPlaceholder(field.placeholder)} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`option.${option}`, { defaultValue: option })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      default:
        return (
          <Input
            id={fieldDomId(field.key)}
            type={field.type}
            value={value || ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={fieldPlaceholder(field.placeholder)}
            className={
              /url|endpoint|host|base|key|token|secret/i.test(field.key)
                ? 'font-mono'
                : undefined
            }
          />
        );
    }
  };

  const renderFieldBlock = (field: ProviderField) => (
    <div key={field.key} className="space-y-2">
      <label className="text-sm font-medium">
        {t(field.label)}
        {field.required && <span className="text-destructive">*</span>}
      </label>
      {renderField(field)}
      {field.tips && (
        <p
          className="text-xs text-muted-foreground"
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
        />
      )}
    </div>
  );

  return (
    <div className="grid gap-4">
      {basicFields.map(renderFieldBlock)}

      {advancedFields.length > 0 && (
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-between px-2 h-9 font-normal text-muted-foreground hover:text-foreground"
            >
              {t('advancedOptions')}
              <ChevronDown
                className={cn(
                  'h-4 w-4 transition-transform',
                  advancedOpen && 'rotate-180',
                )}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="grid gap-4 pt-2">
            {advancedFields.map(renderFieldBlock)}
          </CollapsibleContent>
        </Collapsible>
      )}

      {providerId && values.isAi && (
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
          <p className="text-xs text-muted-foreground">
            {t('customParametersTip')}
          </p>
        </div>
      )}
    </div>
  );
};

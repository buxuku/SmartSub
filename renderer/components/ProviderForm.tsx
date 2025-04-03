import React, { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Eye, EyeOff } from 'lucide-react';
import { ProviderField } from '../../types';
import { useTranslation } from 'next-i18next';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import axios from 'axios';

interface ProviderFormProps {
  fields: ProviderField[];
  values: Record<string, any>;
  onChange: (key: string, value: string | boolean | number) => void;
  showPassword: Record<string, boolean>;
  onTogglePassword: (key: string) => void;
}

export const ProviderForm: React.FC<ProviderFormProps> = ({
  fields,
  values,
  onChange,
  showPassword,
  onTogglePassword,
}) => {
  const { t } = useTranslation('translateControl');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  
  useEffect(() => {
    // 检查是否是Ollama配置页面
    const isOllamaProvider = fields.some(field => field.key === 'modelName' && values.type === 'ollama');
    
    if (isOllamaProvider) {
      const apiUrl = values.apiUrl || 'http://localhost:11434';
      const baseUrl = apiUrl.split('/api/')[0];
      
      // 获取Ollama可用模型列表
      const fetchOllamaModels = async () => {
        try {
          const response = await axios.get(`${baseUrl}/api/tags`);
          if (response.data && response.data.models) {
            const models = response.data.models.map(model => model.name);
            setOllamaModels(models);
          }
        } catch (error) {
          console.error('Failed to fetch Ollama models:', error);
          // 如果获取失败，设置一个默认模型列表
          setOllamaModels(['llama2', 'mistral', 'gemma']);
        }
      };
      
      fetchOllamaModels();
    }
  }, [fields, values.type, values.apiUrl]);
  
  const renderField = (field: ProviderField) => {
    const value = values[field.key] ?? (field.defaultValue || '');
    switch (field.type) {
      case 'switch':
        return (
          <Switch
            className='ml-2 -mt-4'
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
        // 如果是modelName字段且当前是Ollama配置，使用获取到的模型列表
        const options = field.key === 'modelName' && values.type === 'ollama' && ollamaModels.length > 0
          ? ollamaModels
          : field.options || [];
          
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
              ></p>
            )}
          </div>
        );
      })}
    </div>
  );
};

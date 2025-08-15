import React, { useState, useEffect } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Plus, Trash2 } from 'lucide-react';
import { ProviderForm } from '@/components/ProviderForm';
import {
  Provider,
  PROVIDER_TYPES,
  CONFIG_TEMPLATES,
  defaultUserPrompt,
  defaultSystemPrompt,
} from '../../../types';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { cn } from 'lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

const TranslateControl: React.FC = () => {
  const { t } = useTranslation('translateControl');
  const { t: commonT } = useTranslation('common');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newProviderName, setNewProviderName] = useState('');

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    const storedProviders = await window.ipc.invoke('getTranslationProviders');
    console.log('storedProviders', storedProviders);
    setProviders(storedProviders);
    // 默认选中第一个服务商
    if (storedProviders.length > 0 && !selectedProvider) {
      setSelectedProvider(storedProviders[0].type);
    }
  };

  const handleInputChange = async (
    key: string,
    value: string | boolean | number,
  ) => {
    const updatedProviders = providers.map((provider) =>
      provider.id === selectedProvider
        ? { ...provider, [key]: value }
        : provider,
    );
    setProviders(updatedProviders);
    window?.ipc?.send('setTranslationProviders', updatedProviders);
  };

  const togglePasswordVisibility = (key: string) => {
    setShowPassword((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const getCurrentProvider = () => {
    return providers.find((p) => p.id === selectedProvider);
  };

  const getCurrentProviderType = () => {
    const provider = providers.find((p) => p.id === selectedProvider);
    const providerType = PROVIDER_TYPES.find(
      (t) => t.id === (provider?.type || selectedProvider),
    );

    // 如果是自定义服务商，使用配置模板
    if (provider?.type === 'openai') {
      return {
        ...CONFIG_TEMPLATES.openai,
        name: provider.name,
        icon: '🔌',
      };
    }

    return providerType;
  };

  const handleAddProvider = () => {
    if (!newProviderName.trim()) return;

    const newProviderData: Provider = {
      id: `openai_${Date.now()}`,
      name: newProviderName,
      type: 'openai',
      apiUrl: '',
      apiKey: '',
      modelName: '',
      isAi: true,
      prompt: defaultUserPrompt,
      useBatchTranslation: false,
      batchSize: 10,
      systemPrompt: defaultSystemPrompt,
    };

    const updatedProviders = [...providers, newProviderData];
    setProviders(updatedProviders);
    window?.ipc?.send('setTranslationProviders', updatedProviders);
    setIsAddDialogOpen(false);
    setNewProviderName('');
    setSelectedProvider(newProviderData.id);
  };

  const handleProviderSelect = (providerId: string) => {
    setSelectedProvider(providerId);
  };

  const handleRemoveProvider = (providerId: string) => {
    const updatedProviders = providers.filter((p) => p.id !== providerId);
    setProviders(updatedProviders);
    window?.ipc?.send('setTranslationProviders', updatedProviders);
  };

  const [isTestLoading, setIsTestLoading] = useState(false);
  const handleTestTranslation = async () => {
    const currentProvider = getCurrentProvider();
    if (!currentProvider) return;

    setIsTestLoading(true);
    try {
      const result = await window.ipc.invoke('testTranslation', {
        provider: currentProvider,
        sourceLanguage: 'en', // 默认使用英语作为源语言
        targetLanguage: 'zh', // 默认使用中文作为目标语言
      });

      // Handle enhanced result format
      const translation =
        typeof result === 'string' ? result : result.translation;
      const analysis = typeof result === 'object' ? result.analysis : null;

      // Create enhanced success message
      let description = `${t('translationResult')}: "${translation}"`;

      if (analysis) {
        const responseTime = analysis.response_time_ms
          ? ` (${(analysis.response_time_ms / 1000).toFixed(2)}s)`
          : '';
        description += `\n${t('provider')}: ${analysis.provider_name}${responseTime}`;

        if (analysis.model_name) {
          description += `\n${t('model')}: ${analysis.model_name}`;
        }
      }

      toast.success(t('testSuccess'), {
        description,
        duration: 5000, // Show longer to read analysis
      });
    } catch (error) {
      toast.error(t('testFailed'), {
        description: error.message,
      });
    } finally {
      setIsTestLoading(false);
    }
  };

  return (
    <div className="flex h-full">
      {/* 左侧服务商列表 */}
      <div className="w-64 border-r p-4 space-y-2">
        <div className="flex flex-col space-y-4">
          <h2 className="text-lg font-bold">{t('translationServices')}</h2>

          {/* 添加新服务商按钮 */}
          <Button
            variant="outline"
            className="w-full flex items-center justify-center"
            onClick={() => setIsAddDialogOpen(true)}
          >
            <Plus size={16} className="mr-2" />
            {t('addCustomProvider')}
          </Button>
        </div>

        <div className="space-y-1 mt-4">
          {/* 内置服务商 */}
          <div className="text-sm font-medium text-muted-foreground mb-2">
            {t('builtinProviders')}
          </div>
          {PROVIDER_TYPES.filter((t) => t.isBuiltin).map((type) => (
            <button
              key={type.id}
              onClick={() => handleProviderSelect(type.id)}
              className={cn(
                'w-full text-left px-4 py-2 rounded-lg flex items-center space-x-2',
                selectedProvider === type.id
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted',
              )}
            >
              <span className="text-xl">
                {type.iconImg ? (
                  <img src={type.iconImg} className="w-5" />
                ) : (
                  type.icon
                )}
              </span>
              <span>
                {commonT(`provider.${type.name}`, { defaultValue: type.name })}
              </span>
            </button>
          ))}

          {/* 自定义服务商 */}
          {providers.filter((p) => p.type === 'openai').length > 0 && (
            <>
              <div className="text-sm font-medium text-muted-foreground mt-4 mb-2">
                {t('customProviders')}
              </div>
              {providers
                .filter((p) => p.type === 'openai')
                .map((provider) => (
                  <button
                    key={provider.id}
                    onClick={() => setSelectedProvider(provider.id)}
                    className={cn(
                      'w-full text-left px-4 py-2 rounded-lg flex items-center justify-between group',
                      selectedProvider === provider.id
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted',
                    )}
                  >
                    <div className="flex items-center space-x-2">
                      <span className="text-xl">🔌</span>
                      <span>{provider.name}</span>
                    </div>
                    <span
                      className="opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveProvider(provider.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </span>
                  </button>
                ))}
            </>
          )}
        </div>
      </div>

      {/* 右侧配置面板 */}
      <div className="flex-1 p-6">
        {selectedProvider && getCurrentProviderType() && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold flex items-center space-x-2">
                <span className="text-2xl">
                  {getCurrentProviderType()?.iconImg ? (
                    <img
                      src={getCurrentProviderType().iconImg}
                      className="w-6"
                    />
                  ) : (
                    getCurrentProviderType()?.icon
                  )}
                </span>
                <span>
                  {commonT(`provider.${getCurrentProviderType().name}`, {
                    defaultValue: getCurrentProviderType().name,
                  })}
                </span>
              </h1>
              <Button
                variant="outline"
                onClick={handleTestTranslation}
                disabled={isTestLoading}
              >
                {isTestLoading ? t('testing') : t('testTranslation')}
              </Button>
            </div>

            <Card>
              <CardContent className="pt-6">
                <ProviderForm
                  fields={getCurrentProviderType()?.fields || []}
                  values={getCurrentProvider() || {}}
                  onChange={handleInputChange}
                  showPassword={showPassword}
                  onTogglePassword={togglePasswordVisibility}
                  providerId={selectedProvider || ''}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* 添加服务商对话框 */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('addCustomProvider')}</DialogTitle>
            <DialogDescription>
              Create a new custom translation provider with your preferred
              settings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('providerName')}
                <span className="text-red-500">*</span>
              </label>
              <Input
                value={newProviderName}
                onChange={(e) => setNewProviderName(e.target.value)}
                placeholder={t('enterProviderName')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsAddDialogOpen(false);
                setNewProviderName('');
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleAddProvider}
              disabled={!newProviderName.trim()}
            >
              {t('add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TranslateControl;

export const getStaticProps = makeStaticProperties([
  'common',
  'translateControl',
  'parameters',
]);
export { getStaticPaths };

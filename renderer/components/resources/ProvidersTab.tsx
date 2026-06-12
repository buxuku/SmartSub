import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Plug } from 'lucide-react';
import { ProviderForm } from '@/components/ProviderForm';
import {
  Provider,
  PROVIDER_TYPES,
  CONFIG_TEMPLATES,
  defaultUserPrompt,
  defaultSystemPrompt,
} from '../../../types';
import { cn } from 'lib/utils';
import { isProviderConfigured } from 'lib/providerUtils';
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
import { useConfirmOrUndo } from 'hooks/useConfirmOrUndo';

/** 品牌 logo 统一放在白色圆角底上，保证深色模式与选中态下都清晰可见 */
function ProviderIcon({
  iconImg,
  icon,
  size = 'sm',
}: {
  iconImg?: string;
  icon?: string;
  size?: 'sm' | 'lg';
}) {
  const isCustom = !iconImg && icon === '🔌';
  return (
    <span
      className={cn(
        'flex flex-shrink-0 items-center justify-center bg-white ring-1 ring-black/[0.08] dark:ring-white/20',
        size === 'sm' ? 'h-6 w-6 rounded-md' : 'h-9 w-9 rounded-lg',
      )}
    >
      {iconImg ? (
        <img
          src={iconImg}
          alt=""
          className={cn(
            'object-contain',
            size === 'sm' ? 'h-4 w-4' : 'h-6 w-6',
          )}
        />
      ) : isCustom ? (
        <Plug
          className={cn(
            'text-zinc-500',
            size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5',
          )}
        />
      ) : (
        <span
          className={cn('leading-none', size === 'sm' ? 'text-sm' : 'text-xl')}
        >
          {icon}
        </span>
      )}
    </span>
  );
}

const ProvidersTab: React.FC = () => {
  const { t } = useTranslation('translateControl');
  const { t: commonT } = useTranslation('common');
  const confirmOrUndo = useConfirmOrUndo();
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
    // 默认选中第一个服务商（必须用 id：自定义服务商的 type 恒为 'openai'，匹配不到面板）
    if (storedProviders.length > 0 && !selectedProvider) {
      setSelectedProvider(storedProviders[0].id);
    }
  };

  // 持久化降噪：本地 state 即时更新，IPC 写入 500ms debounce，卸载时 flush
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProvidersRef = useRef<Provider[] | null>(null);

  const schedulePersist = useCallback((updatedProviders: Provider[]) => {
    pendingProvidersRef.current = updatedProviders;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      if (pendingProvidersRef.current) {
        window?.ipc?.send(
          'setTranslationProviders',
          pendingProvidersRef.current,
        );
        pendingProvidersRef.current = null;
      }
    }, 500);
  }, []);

  // 立即持久化（新增/删除等结构变更），并废弃挂起的 debounce，防止旧数组回写覆盖
  const persistNow = useCallback((updatedProviders: Provider[]) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    pendingProvidersRef.current = null;
    window?.ipc?.send('setTranslationProviders', updatedProviders);
  }, []);

  useEffect(() => {
    return () => {
      // 卸载前 flush，避免最后一次输入丢失
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      if (pendingProvidersRef.current) {
        window?.ipc?.send(
          'setTranslationProviders',
          pendingProvidersRef.current,
        );
        pendingProvidersRef.current = null;
      }
    };
  }, []);

  const handleInputChange = (key: string, value: string | boolean | number) => {
    const updatedProviders = providers.map((provider) =>
      provider.id === selectedProvider
        ? { ...provider, [key]: value }
        : provider,
    );
    setProviders(updatedProviders);
    schedulePersist(updatedProviders);
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

  const isConfiguredById = (providerId: string) =>
    isProviderConfigured(providers.find((p) => p.id === providerId));

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
      structuredOutput: 'json_schema', // 为新的自定义OpenAI provider设置默认值
    };

    const updatedProviders = [...providers, newProviderData];
    setProviders(updatedProviders);
    persistNow(updatedProviders);
    setIsAddDialogOpen(false);
    setNewProviderName('');
    setSelectedProvider(newProviderData.id);
  };

  const handleProviderSelect = (providerId: string) => {
    setSelectedProvider(providerId);
  };

  const handleRemoveProvider = (providerId: string) => {
    const prevProviders = providers;
    const prevSelected = selectedProvider;
    const removed = providers.find((p) => p.id === providerId);
    const updatedProviders = providers.filter((p) => p.id !== providerId);
    setProviders(updatedProviders);
    persistNow(updatedProviders);
    // 删的是当前选中项：回落到第一个仍存在的服务商
    if (selectedProvider === providerId) {
      setSelectedProvider(updatedProviders[0]?.id ?? null);
    }
    confirmOrUndo(
      t('providerRemoved', { name: removed?.name ?? providerId }) ||
        `已删除服务商「${removed?.name ?? providerId}」`,
      () => {
        setProviders(prevProviders);
        persistNow(prevProviders);
        setSelectedProvider(prevSelected);
      },
    );
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
    <div className="flex h-full overflow-hidden">
      {/* 左侧服务商列表 */}
      <div className="w-64 border-r p-4 space-y-2 overflow-auto">
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
              <ProviderIcon iconImg={type.iconImg} icon={type.icon} />
              <span className="min-w-0 flex-1 truncate">
                {commonT(`provider.${type.name}`, { defaultValue: type.name })}
              </span>
              {isConfiguredById(type.id) && (
                <Badge
                  variant="outline"
                  className="ml-auto flex-shrink-0 border-success/50 px-1.5 py-0 text-[10px] text-success"
                >
                  {t('configured')}
                </Badge>
              )}
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
                  <div
                    key={provider.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedProvider(provider.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedProvider(provider.id);
                      }
                    }}
                    className={cn(
                      'w-full text-left px-4 py-2 rounded-lg flex items-center justify-between group cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      selectedProvider === provider.id
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-muted',
                    )}
                  >
                    <div className="flex items-center space-x-2 min-w-0 flex-1">
                      <ProviderIcon icon="🔌" />
                      <span className="truncate" title={provider.name}>
                        {provider.name}
                      </span>
                    </div>
                    {isConfiguredById(provider.id) && (
                      <Badge
                        variant="outline"
                        className="mr-1 flex-shrink-0 border-success/50 px-1.5 py-0 text-[10px] text-success"
                      >
                        {t('configured')}
                      </Badge>
                    )}
                    <button
                      type="button"
                      aria-label={t('removeProviderAria', {
                        name: provider.name,
                      })}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded flex-shrink-0 ml-2 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveProvider(provider.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
            </>
          )}
        </div>
      </div>

      {/* 右侧配置面板 */}
      <div className="flex-1 p-6 overflow-auto">
        {selectedProvider && getCurrentProviderType() && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold flex items-center space-x-2.5">
                <ProviderIcon
                  iconImg={getCurrentProviderType()?.iconImg}
                  icon={getCurrentProviderType()?.icon}
                  size="lg"
                />
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
            <DialogDescription>{t('addCustomProviderDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t('providerName')}
                <span className="text-destructive">*</span>
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

export default ProvidersTab;

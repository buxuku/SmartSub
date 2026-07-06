import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Plus,
  Trash2,
  Plug,
  Search,
  FlaskConical,
  X,
  Loader2,
  ChevronDown,
  ChevronLeft,
  Pencil,
  Check,
} from 'lucide-react';
import { ProviderForm } from '@/components/ProviderForm';
import {
  Provider,
  PROVIDER_TYPES,
  CONFIG_TEMPLATES,
  defaultUserPrompt,
  defaultSystemPrompt,
  STRUCTURED_OUTPUT_MODES,
  StructuredOutputMode,
} from '../../../types';
import { cn } from 'lib/utils';
import { isProviderConfigured } from 'lib/providerUtils';
import {
  formatProviderError,
  LAST_PROVIDER_STORAGE_KEY,
  providersOrderChanged,
  resolveSelectedProviderId,
  resolveSelectedProviderIdAsync,
  sortProvidersCustomFirst,
  syncTranslateProviderToUserConfig,
} from 'lib/providerPanelUtils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useConfirmOrUndo } from 'hooks/useConfirmOrUndo';
import useLocalStorageState from 'hooks/useLocalStorageState';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

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

const TEST_LANGS = { source: 'en', target: 'zh' } as const;

type TestResult = {
  providerId: string;
  status: 'success' | 'error';
  translation?: string;
  error?: string;
  elapsedMs?: number;
  model?: string;
  source: string;
  target: string;
  /** 自动探测成功后切换到的结构化输出模式 */
  autoSwitchedMode?: StructuredOutputMode;
  /** 自动探测已尝试所有结构化输出模式仍失败 */
  triedAllModes?: boolean;
};

/** 结构化输出模式的展示名（与 structuredOutputTips 用词一致） */
const STRUCTURED_OUTPUT_LABELS: Record<StructuredOutputMode, string> = {
  disabled: 'Disabled',
  json_object: 'JSON Object',
  json_schema: 'JSON Schema',
};

/**
 * 鉴权/网络类错误：换结构化输出参数无意义，跳过自动探测避免浪费调用。
 */
function isDetectSkippableError(error: unknown): boolean {
  const raw = (
    error instanceof Error ? error.message : String(error ?? '')
  ).toLowerCase();
  return [
    '401',
    '403',
    'unauthorized',
    'forbidden',
    'api key',
    'apikey',
    'invalid credentials',
    'missingkeyorsecret',
    'quota',
    'insufficient',
    'enotfound',
    'econnrefused',
    'eai_again',
    'etimedout',
    'timeout',
    'fetch failed',
    '配置不完整',
  ].some((keyword) => raw.includes(keyword));
}

/** 推荐卡：免费起步 / 质量优先，名字直接可点选中 */
const RECOMMEND_ROWS: { labelKey: string; ids: string[] }[] = [
  { labelKey: 'groupFree', ids: ['autoFree'] },
  { labelKey: 'recommendQuality', ids: ['deepseek', 'Gemini'] },
];

const ProvidersTab: React.FC = () => {
  const { t } = useTranslation('translateControl');
  const { t: commonT } = useTranslation('common');
  const confirmOrUndo = useConfirmOrUndo();
  const [removeTarget, setRemoveTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderApiUrl, setNewProviderApiUrl] = useState('');
  const [providerQuery, setProviderQuery] = useState('');
  const [showConfiguredOnly, setShowConfiguredOnly] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useLocalStorageState<
    Record<string, boolean>
  >('providersGroupCollapsed', {}, (v) => v !== null && typeof v === 'object');
  const [saveFlash, setSaveFlash] = useState(false);
  const [autoFocusField, setAutoFocusField] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [mobileShowPanel, setMobileShowPanel] = useState(false);
  const saveFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const panelScrollRef = useRef<HTMLDivElement>(null);
  const [lastSelectedId, setLastSelectedId] = useLocalStorageState<string>(
    LAST_PROVIDER_STORAGE_KEY,
    '',
    (v) => typeof v === 'string',
  );

  const resolveSelectedProvider = useCallback(
    (list: Provider[], preferredId?: string | null) =>
      resolveSelectedProviderId(
        list,
        preferredId ?? (lastSelectedId || undefined),
      ),
    [lastSelectedId],
  );

  const flashSaved = useCallback(() => {
    setSaveFlash(true);
    if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current);
    saveFlashTimer.current = setTimeout(() => setSaveFlash(false), 2000);
  }, []);

  useEffect(() => {
    loadProviders();
  }, []);

  useEffect(
    () => () => {
      if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!lastSelectedId || providers.length === 0) return;
    if (
      providers.some((p) => p.id === lastSelectedId) &&
      selectedProvider !== lastSelectedId
    ) {
      setSelectedProvider(lastSelectedId);
    }
  }, [lastSelectedId, providers, selectedProvider]);

  const loadProviders = async () => {
    const raw = await window.ipc.invoke('getTranslationProviders');
    const storedProviders = sortProvidersCustomFirst(raw || []);
    if (providersOrderChanged(raw || [], storedProviders)) {
      window?.ipc?.send('setTranslationProviders', storedProviders);
    }
    setProviders(storedProviders);
    const resolved = await resolveSelectedProviderIdAsync(
      storedProviders,
      lastSelectedId || undefined,
    );
    setSelectedProvider(resolved);
    if (resolved) setLastSelectedId(resolved);
  };

  // 持久化降噪：本地 state 即时更新，IPC 写入 500ms debounce，卸载时 flush
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProvidersRef = useRef<Provider[] | null>(null);

  const schedulePersist = useCallback(
    (updatedProviders: Provider[]) => {
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
          flashSaved();
        }
      }, 500);
    },
    [flashSaved],
  );

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

  const selectProvider = (providerId: string) => {
    setSelectedProvider(providerId);
    setLastSelectedId(providerId);
    setTestResult(null);
    setIsRenaming(false);
    setMobileShowPanel(true);
    void syncTranslateProviderToUserConfig(providerId);
  };

  const handleInputChange = (key: string, value: string | boolean | number) => {
    const updatedProviders = providers.map((provider) =>
      provider.id === selectedProvider
        ? { ...provider, [key]: value }
        : provider,
    );
    setProviders(updatedProviders);
    schedulePersist(updatedProviders);
  };

  const handleRenameSave = () => {
    const name = renameDraft.trim();
    if (!name || !selectedProvider) return;
    handleInputChange('name', name);
    setIsRenaming(false);
  };

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [key]: !prev?.[key],
    }));
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
      name: newProviderName.trim(),
      type: 'openai',
      apiUrl: newProviderApiUrl.trim(),
      apiKey: '',
      modelName: '',
      isAi: true,
      prompt: defaultUserPrompt,
      useBatchTranslation: false,
      batchSize: 10,
      batchConcurrency: 1,
      systemPrompt: defaultSystemPrompt,
      structuredOutput: 'json_object',
    };

    const updatedProviders = sortProvidersCustomFirst([
      newProviderData,
      ...providers,
    ]);
    setProviders(updatedProviders);
    persistNow(updatedProviders);
    setIsAddDialogOpen(false);
    setNewProviderName('');
    setNewProviderApiUrl('');
    selectProvider(newProviderData.id);
    setAutoFocusField(newProviderApiUrl.trim() ? 'apiKey' : 'apiUrl');
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
      const next = resolveSelectedProvider(updatedProviders);
      setSelectedProvider(next);
      if (next) setLastSelectedId(next);
    }
    confirmOrUndo(
      t('providerRemoved', { name: removed?.name ?? providerId }) ||
        `已删除服务商「${removed?.name ?? providerId}」`,
      () => {
        setProviders(prevProviders);
        persistNow(prevProviders);
        setSelectedProvider(prevSelected);
        if (prevSelected) setLastSelectedId(prevSelected);
      },
    );
  };

  const [isTestLoading, setIsTestLoading] = useState(false);
  // 自动探测进行中：当前正在尝试的结构化输出模式
  const [detectingMode, setDetectingMode] =
    useState<StructuredOutputMode | null>(null);

  const handleTestTranslation = async () => {
    const currentProvider = getCurrentProvider();
    if (!currentProvider) return;

    const { source, target } = TEST_LANGS;
    if (!isProviderConfigured(currentProvider)) {
      setTestResult({
        providerId: currentProvider.id,
        status: 'error',
        error: t('testNeedsConfig'),
        source,
        target,
      });
      return;
    }

    // 结构化输出字段定义（仅 AI 服务商有）：存在才启用自动探测
    const structuredOutputField = getCurrentProviderType()?.fields?.find(
      (f) => f.key === 'structuredOutput',
    );

    const invokeTest = (provider: Provider) =>
      window.ipc.invoke('testTranslation', {
        provider,
        sourceLanguage: source,
        targetLanguage: target,
      });

    const buildSuccessResult = (
      result: any,
      startedAt: number,
      autoSwitchedMode?: StructuredOutputMode,
    ): TestResult => {
      const translation =
        typeof result === 'string' ? result : result.translation;
      const analysis = typeof result === 'object' ? result.analysis : null;
      return {
        providerId: currentProvider.id,
        status: 'success',
        translation,
        elapsedMs: analysis?.response_time_ms ?? Date.now() - startedAt,
        model: analysis?.model_name || currentProvider.modelName,
        source,
        target,
        autoSwitchedMode,
      };
    };

    setIsTestLoading(true);
    setDetectingMode(null);
    panelScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    const startedAt = Date.now();
    try {
      // 有结构化输出字段时以严格模式测试（禁用主进程静默降级），
      // 这样才能探测出真实可用的模式并写回配置
      const result = await invokeTest(
        structuredOutputField
          ? { ...currentProvider, strictStructuredOutput: true }
          : currentProvider,
      );
      setTestResult(buildSuccessResult(result, startedAt));
      toast.success(t('testSuccess'));
    } catch (error) {
      // 自动探测：依次尝试其余结构化输出模式，找到可用项即保存
      if (structuredOutputField && !isDetectSkippableError(error)) {
        const currentMode: StructuredOutputMode =
          currentProvider.structuredOutput &&
          (STRUCTURED_OUTPUT_MODES as string[]).includes(
            currentProvider.structuredOutput,
          )
            ? currentProvider.structuredOutput
            : currentProvider.useJsonMode === false
              ? 'disabled'
              : (structuredOutputField.defaultValue as StructuredOutputMode) ||
                'json_object';
        const candidates = STRUCTURED_OUTPUT_MODES.filter(
          (mode) => mode !== currentMode,
        );

        for (const mode of candidates) {
          setDetectingMode(mode);
          const retryStartedAt = Date.now();
          try {
            const result = await invokeTest({
              ...currentProvider,
              structuredOutput: mode,
              strictStructuredOutput: true,
            });
            // 探测成功：自动写回配置（走既有编辑保存链路）
            handleInputChange('structuredOutput', mode);
            setTestResult(buildSuccessResult(result, retryStartedAt, mode));
            toast.success(
              t('autoDetectSwitched', {
                mode: STRUCTURED_OUTPUT_LABELS[mode],
              }),
            );
            return;
          } catch {
            // 该模式也不行，继续下一个
          }
        }
      }

      setTestResult({
        providerId: currentProvider.id,
        status: 'error',
        error: formatProviderError(error, t),
        source,
        target,
        triedAllModes:
          !!structuredOutputField && !isDetectSkippableError(error),
      });
    } finally {
      setIsTestLoading(false);
      setDetectingMode(null);
    }
  };

  const currentProviderConfigured = selectedProvider
    ? isConfiguredById(selectedProvider)
    : false;

  const langName = (code: string) =>
    commonT(`language.${code}`, { defaultValue: code });

  const typeDisplayName = (type: { name: string }) =>
    commonT(`provider.${type.name}`, { defaultValue: type.name });

  const trimmedQuery = providerQuery.trim().toLowerCase();
  const matchesQuery = (displayName: string, rawName?: string) =>
    !trimmedQuery ||
    displayName.toLowerCase().includes(trimmedQuery) ||
    (rawName ?? '').toLowerCase().includes(trimmedQuery);

  const groupSections = (
    [
      { key: 'free', titleKey: 'groupFree' },
      { key: 'ai', titleKey: 'groupAi' },
      { key: 'mt', titleKey: 'groupMt' },
    ] as const
  ).map((section) => ({
    ...section,
    items: PROVIDER_TYPES.filter(
      (pt) =>
        pt.isBuiltin &&
        (pt.group ?? 'mt') === section.key &&
        matchesQuery(typeDisplayName(pt), pt.name) &&
        (!showConfiguredOnly || isConfiguredById(pt.id)),
    ),
  }));

  const visibleCustomProviders = providers.filter(
    (p) =>
      p.type === 'openai' &&
      matchesQuery(p.name) &&
      (!showConfiguredOnly || isConfiguredById(p.id)),
  );

  const nothingMatched =
    trimmedQuery &&
    groupSections.every((s) => s.items.length === 0) &&
    visibleCustomProviders.length === 0;

  const isCustomSelected = getCurrentProvider()?.type === 'openai';

  const panelTitle = () => {
    const provider = getCurrentProvider();
    const type = getCurrentProviderType();
    if (isCustomSelected && provider) return provider.name;
    if (!type) return '';
    return commonT(`provider.${type.name}`, { defaultValue: type.name });
  };

  return (
    <div className="flex h-full overflow-hidden flex-col lg:flex-row">
      {/* 左侧服务商列表 */}
      <div
        className={cn(
          'w-full lg:w-64 border-b lg:border-b-0 lg:border-r p-4 space-y-2 overflow-auto shrink-0',
          'max-h-[42vh] lg:max-h-none',
          mobileShowPanel && selectedProvider && 'hidden lg:block',
        )}
      >
        <div className="flex flex-col space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {t('providerListTitle')}
            </h2>
            {saveFlash && (
              <span className="flex items-center gap-1 text-xs text-success animate-in fade-in">
                <Check className="h-3 w-3" />
                {t('savedFlash')}
              </span>
            )}
          </div>

          {/* 添加自定义 AI 服务 */}
          <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('addCustomProviderHint')}
            </p>
            <Button
              variant="default"
              size="sm"
              className="w-full flex items-center justify-center gap-1.5"
              onClick={() => setIsAddDialogOpen(true)}
            >
              <Plus size={16} />
              {t('addCustomProvider')}
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 py-1">
          <label
            htmlFor="show-configured-only"
            className="text-xs text-muted-foreground cursor-pointer select-none"
          >
            {t('showConfiguredOnly')}
          </label>
          <Switch
            id="show-configured-only"
            checked={showConfiguredOnly}
            onCheckedChange={setShowConfiguredOnly}
          />
        </div>

        {/* 搜索 */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={providerQuery}
            onChange={(e) => setProviderQuery(e.target.value)}
            placeholder={t('providerSearchPlaceholder')}
            className="h-8 pl-8 text-sm"
          />
        </div>

        {/* 推荐卡：搜索时隐藏 */}
        {!trimmedQuery && (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 space-y-1.5">
            <div className="label-caps">{t('recommendTitle')}</div>
            {RECOMMEND_ROWS.map((row) => (
              <div
                key={row.labelKey}
                className="flex flex-wrap items-center gap-x-1 text-xs"
              >
                <span className="text-muted-foreground">{t(row.labelKey)}</span>
                {row.ids.map((id, i) => {
                  const type = PROVIDER_TYPES.find((pt) => pt.id === id);
                  if (!type) return null;
                  return (
                    <React.Fragment key={id}>
                      {i > 0 && (
                        <span className="text-muted-foreground">·</span>
                      )}
                      <button
                        type="button"
                        className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
                        onClick={() => selectProvider(id)}
                      >
                        {typeDisplayName(type)}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-1 mt-4">
          {/* 自定义服务商（置顶：用户自添的一般为常用） */}
          {visibleCustomProviders.length > 0 && (
            <>
              <div className="text-sm font-medium text-muted-foreground mb-2">
                {t('customProviders')}
              </div>
              {visibleCustomProviders.map((provider) => (
                <div
                  key={provider.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectProvider(provider.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectProvider(provider.id);
                    }
                  }}
                  className={cn(
                    'w-full text-left px-4 py-2 rounded-lg flex items-center justify-between group cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    selectedProvider === provider.id
                      ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/20'
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
                      className="mr-1 flex-shrink-0 border-success/40 px-1.5 py-0 text-[10px] text-success"
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
                      setRemoveTarget({ id: provider.id, name: provider.name });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </>
          )}

          {/* 三个分组段（可折叠） */}
          {groupSections.map(
            (section) =>
              section.items.length > 0 && (
                <Collapsible
                  key={section.key}
                  open={!collapsedGroups[section.key]}
                  onOpenChange={() => toggleGroupCollapsed(section.key)}
                >
                  <CollapsibleTrigger className="flex w-full items-center justify-between mt-4 mb-2 first:mt-0 text-muted-foreground hover:text-foreground">
                    <span className="label-caps">{t(section.titleKey)}</span>
                    <ChevronDown
                      className={cn(
                        'h-4 w-4 transition-transform',
                        collapsedGroups[section.key] && '-rotate-90',
                      )}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-1">
                    {section.items.map((type) => (
                      <button
                        key={type.id}
                        onClick={() => selectProvider(type.id)}
                        className={cn(
                          'w-full text-left px-4 py-2 rounded-lg flex items-center space-x-2',
                          selectedProvider === type.id
                            ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/20'
                            : 'hover:bg-muted',
                        )}
                      >
                        <ProviderIcon iconImg={type.iconImg} icon={type.icon} />
                        <span
                          className="min-w-0 flex-1 truncate"
                          title={typeDisplayName(type)}
                        >
                          {typeDisplayName(type)}
                        </span>
                        {isConfiguredById(type.id) && (
                          <Badge
                            variant="outline"
                            className="ml-auto flex-shrink-0 border-success/40 px-1.5 py-0 text-[10px] text-success"
                          >
                            {t('configured')}
                          </Badge>
                        )}
                      </button>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ),
          )}

          {/* 无匹配 */}
          {nothingMatched && (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              {t('noProviderMatch')}
            </p>
          )}
        </div>
      </div>

      {/* 右侧配置面板 */}
      <div
        ref={panelScrollRef}
        className={cn(
          'flex-1 overflow-auto min-h-0',
          !mobileShowPanel && !selectedProvider && 'hidden lg:block',
        )}
      >
        {selectedProvider && getCurrentProviderType() && (
          <>
            <div className="sticky top-0 z-10 border-b bg-background px-4 lg:px-6 py-4 shadow-sm space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="lg:hidden shrink-0"
                    onClick={() => setMobileShowPanel(false)}
                    aria-label={t('backToList')}
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </Button>
                  <h1 className="text-xl lg:text-2xl font-bold flex items-center space-x-2.5 min-w-0">
                    <ProviderIcon
                      iconImg={getCurrentProviderType()?.iconImg}
                      icon={getCurrentProviderType()?.icon}
                      size="lg"
                    />
                    {isRenaming && isCustomSelected ? (
                      <Input
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRenameSave();
                          if (e.key === 'Escape') setIsRenaming(false);
                        }}
                        className="h-9 max-w-[200px]"
                        autoFocus
                      />
                    ) : (
                      <span className="truncate">{panelTitle()}</span>
                    )}
                    {isCustomSelected && !isRenaming && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => {
                          setRenameDraft(getCurrentProvider()?.name ?? '');
                          setIsRenaming(true);
                        }}
                        aria-label={t('renameProvider')}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {isRenaming && isCustomSelected && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={handleRenameSave}
                        aria-label={t('saveRename')}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                    )}
                  </h1>
                </div>
                <Button
                  variant="outline"
                  className="gap-1.5 shrink-0"
                  onClick={handleTestTranslation}
                  disabled={isTestLoading || !currentProviderConfigured}
                >
                  <FlaskConical className="h-4 w-4" />
                  {isTestLoading ? t('testing') : t('testTranslation')}
                </Button>
              </div>

              {!currentProviderConfigured && (
                <p className="text-xs text-muted-foreground">
                  {t('testNeedsConfig')}
                </p>
              )}

              {isTestLoading && (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                  {detectingMode
                    ? t('autoDetectTrying', {
                        mode: STRUCTURED_OUTPUT_LABELS[detectingMode],
                      })
                    : t('testing')}
                </div>
              )}

              {!isTestLoading &&
                testResult &&
                testResult.providerId === selectedProvider && (
                  <div
                    className={cn(
                      'rounded-md border px-3 py-2.5 space-y-1.5 text-sm',
                      testResult.status === 'success'
                        ? 'border-success/30 bg-success/5'
                        : 'border-destructive/30 bg-destructive/5',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          'font-medium',
                          testResult.status === 'success'
                            ? 'text-success'
                            : 'text-destructive',
                        )}
                      >
                        {testResult.status === 'success'
                          ? t('testSuccess')
                          : t('testFailed')}
                      </span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {langName(testResult.source)} →{' '}
                        {langName(testResult.target)}
                        {testResult.elapsedMs != null &&
                          ` · ${(testResult.elapsedMs / 1000).toFixed(2)}s`}
                      </span>
                    </div>
                    {testResult.status === 'success' ? (
                      <>
                        <p className="break-all">
                          {t('translationResult')}: "{testResult.translation}"
                        </p>
                        {testResult.autoSwitchedMode && (
                          <p className="text-xs text-muted-foreground">
                            {t('autoDetectSwitched', {
                              mode: STRUCTURED_OUTPUT_LABELS[
                                testResult.autoSwitchedMode
                              ],
                            })}
                          </p>
                        )}
                        {testResult.model && (
                          <p className="text-xs text-muted-foreground">
                            {t('model')}: {testResult.model}
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="break-all text-destructive">
                          {testResult.error}
                        </p>
                        {testResult.triedAllModes && (
                          <p className="text-xs text-muted-foreground">
                            {t('autoDetectAllFailed')}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
            </div>

            <div className="p-4 lg:p-6 pt-4">
              <Card>
                <CardContent className="pt-6">
                  <ProviderForm
                    fields={getCurrentProviderType()?.fields || []}
                    values={getCurrentProvider() || {}}
                    onChange={handleInputChange}
                    showPassword={showPassword}
                    onTogglePassword={togglePasswordVisibility}
                    providerId={selectedProvider || ''}
                    autoFocusField={autoFocusField}
                  />
                </CardContent>
              </Card>
            </div>
          </>
        )}
        {!selectedProvider && (
          <div className="hidden lg:flex h-full items-center justify-center text-sm text-muted-foreground p-6">
            {t('selectProviderHint')}
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
              <label
                htmlFor="new-provider-name"
                className="text-sm font-medium"
              >
                {t('providerName')}
                <span className="text-destructive">*</span>
              </label>
              <Input
                id="new-provider-name"
                value={newProviderName}
                onChange={(e) => setNewProviderName(e.target.value)}
                placeholder={t('enterProviderName')}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="new-provider-api-url"
                className="text-sm font-medium"
              >
                {t('ApiUrl')}
              </label>
              <Input
                id="new-provider-api-url"
                value={newProviderApiUrl}
                onChange={(e) => setNewProviderApiUrl(e.target.value)}
                placeholder={t('phOpenaiApiUrl')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setIsAddDialogOpen(false);
                setNewProviderName('');
                setNewProviderApiUrl('');
              }}
            >
              <X className="h-4 w-4" />
              {t('cancel')}
            </Button>
            <Button
              onClick={handleAddProvider}
              disabled={!newProviderName.trim()}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              {t('add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmRemoveProvider')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('removeProviderConfirmDesc', {
                name: removeTarget?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (removeTarget) handleRemoveProvider(removeTarget.id);
                setRemoveTarget(null);
              }}
            >
              <Trash2 className="h-4 w-4" />
              {commonT('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ProvidersTab;

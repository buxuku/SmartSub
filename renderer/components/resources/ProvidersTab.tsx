import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Panel, PanelHeader } from '@/components/ui/panel';
import TranslationOverviewPanel from '@/components/resources/TranslationOverviewPanel';
import {
  Plus,
  Trash2,
  Plug,
  Search,
  FlaskConical,
  X,
  LayoutGrid,
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
  /**
   * 思考状态徽标（openspec: ai-thinking-mode-control D7）：
   * 仅开关为关且主进程返回了判定结论时有值——
   * 'disabled' = 思考已关闭；'active' = 无法关闭思考（模型限制）
   */
  thinkingStatus?: 'disabled' | 'active';
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

/** 「总览」哨兵值：lastSelectedId 记忆为它时落地总览视图（与引擎/配音服务页动线一致） */
const OVERVIEW_ID = '__overview__';

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
    if (
      !lastSelectedId ||
      lastSelectedId === OVERVIEW_ID ||
      providers.length === 0
    ) {
      return;
    }
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
    // 首次进入（无记忆）或记忆为总览时落地总览视图；否则恢复上次选中的服务商
    if (!lastSelectedId || lastSelectedId === OVERVIEW_ID) {
      setSelectedProvider(null);
      return;
    }
    const resolved = await resolveSelectedProviderIdAsync(
      storedProviders,
      lastSelectedId,
    );
    setSelectedProvider(resolved);
    if (resolved) setLastSelectedId(resolved);
  };

  /** 回到总览视图（左栏首项） */
  const goOverview = () => {
    setSelectedProvider(null);
    setLastSelectedId(OVERVIEW_ID);
    setTestResult(null);
    setIsRenaming(false);
    setMobileShowPanel(true);
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
      // 思考徽标仅在「开关为关 + 主进程给出判定」时展示（design D7）；
      // 开关为开表示用户主动放行思考，无需反馈
      const thinkingDisabledByUser = currentProvider.enableThinking !== true;
      const thinkingStatus =
        thinkingDisabledByUser &&
        typeof analysis?.thinking_enabled === 'boolean'
          ? analysis.thinking_enabled
            ? ('active' as const)
            : ('disabled' as const)
          : undefined;
      return {
        providerId: currentProvider.id,
        status: 'success',
        translation,
        elapsedMs: analysis?.response_time_ms ?? Date.now() - startedAt,
        model: analysis?.model_name || currentProvider.modelName,
        source,
        target,
        autoSwitchedMode,
        thinkingStatus,
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

  const customProviders = providers.filter((p) => p.type === 'openai');

  const visibleCustomProviders = customProviders.filter(
    (p) =>
      matchesQuery(p.name) && (!showConfiguredOnly || isConfiguredById(p.id)),
  );

  // 总览三组统计：free/ai/mt 各组的已配置数与首个条目（供「查看」跳转）
  const overviewGroups = (['free', 'ai', 'mt'] as const).map((key) => {
    const items = PROVIDER_TYPES.filter(
      (pt) => pt.isBuiltin && (pt.group ?? 'mt') === key,
    );
    return {
      key,
      configured: items.filter((pt) => isConfiguredById(pt.id)).length,
      total: items.length,
      firstId:
        items.find((pt) => isConfiguredById(pt.id))?.id ?? items[0]?.id ?? null,
    };
  });

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
    <div className="grid h-full min-h-0 grid-cols-1 gap-2.5 overflow-hidden lg:grid-cols-[248px_minmax(0,1fr)]">
      {/* 左侧服务商列表 */}
      <Panel
        className={cn(
          'min-h-0 overflow-hidden',
          mobileShowPanel && 'hidden lg:flex',
        )}
      >
        <PanelHeader
          title={t('providerListTitle')}
          meta={
            saveFlash ? (
              <span className="flex items-center gap-1 text-success animate-in fade-in">
                <Check className="h-3 w-3" />
                {t('savedFlash')}
              </span>
            ) : undefined
          }
          actions={
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t('addCustomProvider')}
              title={t('addCustomProviderHint')}
              onClick={() => setIsAddDialogOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          }
        />

        {/* 搜索 + 已配置过滤 */}
        <div className="flex flex-none flex-col gap-1.5 border-b border-border p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <Input
              value={providerQuery}
              onChange={(e) => setProviderQuery(e.target.value)}
              placeholder={t('providerSearchPlaceholder')}
              className="h-7 pl-8 text-xs"
            />
          </div>
          <div className="flex items-center justify-between gap-2 px-0.5">
            <label
              htmlFor="show-configured-only"
              className="cursor-pointer select-none text-xs text-muted-foreground"
            >
              {t('showConfiguredOnly')}
            </label>
            <Switch
              id="show-configured-only"
              checked={showConfiguredOnly}
              onCheckedChange={setShowConfiguredOnly}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5">
          {/* 总览首项：三个配置页统一的落地视图 */}
          <button
            type="button"
            aria-current={!selectedProvider ? 'true' : undefined}
            onClick={goOverview}
            className={cn(
              'relative flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] transition-colors',
              !selectedProvider
                ? 'bg-primary/10 font-medium text-primary before:absolute before:inset-y-2 before:-left-1.5 before:w-[3px] before:rounded-r-full before:bg-primary'
                : 'text-foreground hover:bg-accent',
            )}
          >
            <span
              className={cn(
                'flex h-6 w-6 flex-none items-center justify-center rounded-md',
                !selectedProvider
                  ? 'bg-primary/15 text-primary'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{t('overview.name')}</span>
              <span className="truncate text-[11px] font-normal text-muted-foreground">
                {t('overview.subtitle')}
              </span>
            </span>
          </button>
          {/* 自定义服务商（置顶：用户自添的一般为常用） */}
          {visibleCustomProviders.length > 0 && (
            <>
              <div className="label-caps px-2 pb-1 pt-2.5">
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
                    'group relative flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    selectedProvider === provider.id
                      ? 'bg-primary/10 font-medium text-primary before:absolute before:inset-y-1.5 before:-left-1.5 before:w-[3px] before:rounded-r-full before:bg-primary'
                      : 'hover:bg-accent',
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
                  <CollapsibleTrigger className="flex w-full items-center justify-between px-2 pb-1 pt-2.5 text-muted-foreground hover:text-foreground">
                    <span className="label-caps">{t(section.titleKey)}</span>
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 transition-transform',
                        collapsedGroups[section.key] && '-rotate-90',
                      )}
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-0.5">
                    {section.items.map((type) => (
                      <button
                        key={type.id}
                        onClick={() => selectProvider(type.id)}
                        className={cn(
                          'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                          selectedProvider === type.id
                            ? 'bg-primary/10 font-medium text-primary before:absolute before:inset-y-1.5 before:-left-1.5 before:w-[3px] before:rounded-r-full before:bg-primary'
                            : 'hover:bg-accent',
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
      </Panel>

      {/* 右侧：总览 / 服务商配置面板 */}
      <Panel
        className={cn(
          'min-h-0 overflow-hidden',
          !mobileShowPanel && 'hidden lg:flex',
        )}
      >
        {!selectedProvider && (
          <>
            <div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold leading-tight">
                  {t('overview.name')}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t('overview.subtitle')}
                </p>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <TranslationOverviewPanel
                groups={overviewGroups}
                freeReady={isConfiguredById('autoFree')}
                aiReady={
                  isConfiguredById('deepseek') || isConfiguredById('Gemini')
                }
                customCount={customProviders.length}
                onSelectProvider={selectProvider}
                onAddCustom={() => setIsAddDialogOpen(true)}
              />
            </div>
          </>
        )}
        {selectedProvider && getCurrentProviderType() && (
          <div ref={panelScrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="sticky top-0 z-10 border-b bg-card px-3 py-2.5 shadow-sm space-y-3">
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
                  <h1 className="flex min-w-0 items-center space-x-2 text-[15px] font-semibold">
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
                        {testResult.thinkingStatus && (
                          <p
                            className={cn(
                              'text-xs',
                              testResult.thinkingStatus === 'disabled'
                                ? 'text-muted-foreground'
                                : 'text-amber-600 dark:text-amber-500',
                            )}
                          >
                            {testResult.thinkingStatus === 'disabled'
                              ? t('testThinkingDisabled')
                              : t('testThinkingCannotDisable')}
                          </p>
                        )}
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

            <div className="p-3">
              <div className="rounded-lg border bg-panel-2/50 p-3.5">
                <ProviderForm
                  fields={getCurrentProviderType()?.fields || []}
                  values={getCurrentProvider() || {}}
                  onChange={handleInputChange}
                  showPassword={showPassword}
                  onTogglePassword={togglePasswordVisibility}
                  providerId={selectedProvider || ''}
                  autoFocusField={autoFocusField}
                />
              </div>
            </div>
          </div>
        )}
      </Panel>

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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  ChevronDown,
  Eye,
  EyeOff,
  FlaskConical,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import {
  buildInstanceFromPreset,
  getAsrPresetsForType,
  getAsrProviderType,
  groupInstancesByType,
  isAsrProviderConfigured,
  parseAsrModels,
  type AsrProvider,
  type AsrProviderField,
} from '../../../../../types/asrProvider';

interface CloudAsrPanelProps {
  /** 实例列表变更时上抛（供左栏就绪徽标即时更新）。 */
  onProvidersChange?: (providers: AsrProvider[]) => void;
}

/**
 * 云端听写（在线 ASR）服务商实例管理面板。
 * 与翻译服务商不同：实例必须携带用户凭据，无内置实例；缺省空列表。
 * 布局与「引擎与模型」右栏一致：实例列表 + 选中实例的凭据表单 + 连通性测试。
 */
const CloudAsrPanel: React.FC<CloudAsrPanelProps> = ({ onProvidersChange }) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [providers, setProviders] = useState<AsrProvider[]>([]);
  const onProvidersChangeRef = useRef(onProvidersChange);
  onProvidersChangeRef.current = onProvidersChange;

  // 统一更新入口：本地 state + 通知父组件（就绪徽标）。
  const applyProviders = useCallback((next: AsrProvider[]) => {
    setProviders(next);
    onProvidersChangeRef.current?.(next);
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 自由型模型标签录入的「输入中」草稿（回车/分隔符提交为标签，避免逗号手拼）。
  const [modelDraft, setModelDraft] = useState('');
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [removeTarget, setRemoveTarget] = useState<AsrProvider | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    id: string;
    ok: boolean;
    message: string;
  } | null>(null);

  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<AsrProvider[] | null>(null);

  useEffect(() => {
    (async () => {
      const raw = (await window?.ipc?.invoke('getAsrProviders')) || [];
      applyProviders(raw);
      if (raw.length) setSelectedId(raw[0].id);
    })();
  }, [applyProviders]);

  const flushPersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    if (pendingRef.current) {
      window?.ipc?.send('setAsrProviders', pendingRef.current);
      pendingRef.current = null;
    }
  }, []);

  useEffect(() => () => flushPersist(), [flushPersist]);

  const schedulePersist = useCallback((next: AsrProvider[]) => {
    pendingRef.current = next;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      if (pendingRef.current) {
        window?.ipc?.send('setAsrProviders', pendingRef.current);
        pendingRef.current = null;
      }
    }, 500);
  }, []);

  const persistNow = useCallback((next: AsrProvider[]) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    pendingRef.current = null;
    window?.ipc?.send('setAsrProviders', next);
  }, []);

  useEffect(() => {
    setModelDraft('');
  }, [selectedId]);

  const selected = providers.find((p) => p.id === selectedId) || null;
  const selectedType = getAsrProviderType(selected?.type);
  // 按服务商类型分区（已知类型恒显示，含空区；未知类型兜底追加末尾）。
  const groups = groupInstancesByType(providers);

  const handleAdd = (typeId: string, presetId?: string) => {
    // 「添加实例」仅在已知类型分区下渲染，故未知类型直接忽略。
    const type = getAsrProviderType(typeId);
    if (!type) return;
    // 品牌型（单例）：已存在实例时不再新建，直接选中既有实例（硬单例封顶 1）。
    if (!type.multiInstance) {
      const existing = providers.find((p) => p.type === type.id);
      if (existing) {
        setSelectedId(existing.id);
        setTestResult(null);
        return;
      }
    }
    const preset = presetId
      ? getAsrPresetsForType(typeId).find((p) => p.id === presetId)
      : undefined;
    const instance = buildInstanceFromPreset(type, preset);
    const next = [instance, ...providers];
    applyProviders(next);
    persistNow(next);
    setSelectedId(instance.id);
    setTestResult(null);
  };

  const handleField = (key: string, value: string | number | boolean) => {
    if (!selected) return;
    const next = providers.map((p) =>
      p.id === selected.id ? { ...p, [key]: value } : p,
    );
    applyProviders(next);
    schedulePersist(next);
  };

  const handleRemove = (id: string) => {
    const next = providers.filter((p) => p.id !== id);
    applyProviders(next);
    persistNow(next);
    if (selectedId === id) {
      setSelectedId(next[0]?.id ?? null);
      setTestResult(null);
    }
  };

  const handleTest = async () => {
    if (!selected) return;
    setTesting(true);
    setTestResult(null);
    try {
      // 连通性自测跑在主进程（规避渲染进程 CORS），按服务商类型选鉴权端点。
      const res = (await window?.ipc?.invoke('testAsrProvider', selected)) as {
        ok?: boolean;
        status?: number;
        needsConfig?: boolean;
        detail?: string;
      };
      if (res?.needsConfig) {
        setTestResult({
          id: selected.id,
          ok: false,
          message: t('cloudAsr.testNeedsConfig'),
        });
      } else if (res?.ok) {
        setTestResult({
          id: selected.id,
          ok: true,
          message: t('cloudAsr.testSuccess'),
        });
        toast.success(t('cloudAsr.testSuccess'));
      } else {
        // 优先展示服务端 detail（如「缺少 speech_to_text 权限」），否则回落状态码/通用文案。
        const base = res?.status
          ? t('cloudAsr.testFailedStatus', { status: res.status })
          : t('cloudAsr.testFailed');
        setTestResult({
          id: selected.id,
          ok: false,
          message: res?.detail ? `${base} ${res.detail}` : base,
        });
      }
    } catch {
      setTestResult({
        id: selected.id,
        ok: false,
        message: t('cloudAsr.testFailed'),
      });
    } finally {
      setTesting(false);
    }
  };

  const writeModels = (models: string[]) => {
    handleField('models', models.join(', '));
  };

  /** 把草稿按分隔符拆成标签并入清单（去空去重），供回车/分隔符/失焦提交。 */
  const commitModelDraft = (raw: string) => {
    const current = parseAsrModels(selected ?? undefined);
    const pieces = raw
      .split(/[,，、;；\s]+/)
      .map((m) => m.trim())
      .filter(Boolean)
      .filter((m) => !current.includes(m));
    if (pieces.length) writeModels([...current, ...pieces]);
    setModelDraft('');
  };

  /**
   * 模型清单录入（数据仍存规范逗号串，仅录入交互结构化）：
   * - 单一 option：固定模型，只读展示不可改（如火山 bigmodel）；
   * - 多 options：勾选式标签（如 Deepgram nova-2/nova-3），不做自由文本；
   * - 无 options（OpenAI 兼容）：标签式录入，回车/分隔符成标签——杜绝半/全角逗号手拼。
   */
  const renderModelsField = (field: AsrProviderField) => {
    const models = parseAsrModels(selected ?? undefined);
    const options = field.options ?? [];

    if (options.length === 1) {
      return (
        <Badge variant="secondary" className="font-mono">
          {options[0]}
        </Badge>
      );
    }

    if (options.length > 1) {
      // 历史存量里不在 options 的 id 仍展示（可取消勾选清理）。
      const extras = models.filter((m) => !options.includes(m));
      const all = [...options, ...extras];
      return (
        <div className="flex flex-wrap gap-1.5">
          {all.map((m) => {
            const active = models.includes(m);
            return (
              <button
                type="button"
                key={m}
                aria-pressed={active}
                onClick={() =>
                  writeModels(
                    active
                      ? models.filter((x) => x !== m)
                      : all.filter((x) => x === m || models.includes(x)),
                  )
                }
                className={cn(
                  'rounded-md border px-2 py-1 font-mono text-xs transition-colors',
                  active
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-input text-muted-foreground hover:bg-muted',
                )}
              >
                {m}
              </button>
            );
          })}
        </div>
      );
    }

    return (
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
        {models.map((m) => (
          <Badge key={m} variant="secondary" className="gap-1 font-mono">
            {m}
            <button
              type="button"
              aria-label={commonT('delete')}
              onClick={() => writeModels(models.filter((x) => x !== m))}
            >
              <X size={12} />
            </button>
          </Badge>
        ))}
        <input
          value={modelDraft}
          onChange={(e) => {
            const v = e.target.value;
            // 输入任一分隔符（含全角）即时成标签，杜绝逗号串手拼。
            if (/[,，、;；]/.test(v)) commitModelDraft(v);
            else setModelDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitModelDraft(modelDraft);
            } else if (
              e.key === 'Backspace' &&
              !modelDraft &&
              models.length > 0
            ) {
              writeModels(models.slice(0, -1));
            }
          }}
          onBlur={() => commitModelDraft(modelDraft)}
          placeholder={t('cloudAsr.modelsAddHint')}
          className="min-w-28 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
    );
  };

  const renderField = (field: AsrProviderField) => {
    const value = selected?.[field.key] ?? field.defaultValue ?? '';
    const label = t(field.label, { defaultValue: field.label });
    const placeholder = field.placeholder
      ? t(field.placeholder, { defaultValue: field.placeholder })
      : undefined;
    const tips = field.tips
      ? t(field.tips, { defaultValue: field.tips })
      : undefined;

    return (
      <div key={field.key} className="space-y-1.5">
        <label className="text-sm font-medium">
          {label}
          {field.required && <span className="text-destructive"> *</span>}
        </label>
        {field.key === 'models' ? (
          renderModelsField(field)
        ) : field.type === 'password' ? (
          <div className="flex items-center gap-1.5">
            <Input
              type={showPassword[field.key] ? 'text' : 'password'}
              value={value}
              onChange={(e) => handleField(field.key, e.target.value)}
              placeholder={placeholder}
              className="font-mono"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() =>
                setShowPassword((prev) => ({
                  ...prev,
                  [field.key]: !prev[field.key],
                }))
              }
            >
              {showPassword[field.key] ? (
                <EyeOff size={16} />
              ) : (
                <Eye size={16} />
              )}
            </Button>
          </div>
        ) : field.type === 'number' ? (
          <Input
            type="number"
            step={field.step}
            value={value}
            onChange={(e) => handleField(field.key, e.target.value)}
            placeholder={placeholder}
          />
        ) : (
          <Input
            type={field.type === 'url' ? 'url' : 'text'}
            value={value}
            onChange={(e) => handleField(field.key, e.target.value)}
            placeholder={placeholder}
            className={/url|key/i.test(field.key) ? 'font-mono' : undefined}
          />
        )}
        {tips && <p className="text-xs text-muted-foreground">{tips}</p>}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('cloudAsr.intro')}
        </p>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* 左栏：按服务商类型分区的实例列表（每区含标题 + 实例 + 区内「添加实例」） */}
        <div className="space-y-3 lg:w-64 lg:shrink-0">
          {groups.map(({ type, instances }) => {
            const known = !!getAsrProviderType(type.id);
            // 协议型（multiInstance）可加多个；品牌型为硬单例（配置一个、封顶 1）。
            const multi = !!type.multiInstance;
            // 协议型的命名预设（Groq / 硅基流动 …）：一键预填 base URL + 模型。
            const presets = getAsrPresetsForType(type.id);
            return (
              <div key={type.id} className="rounded-lg border">
                <div className="flex items-center gap-1.5 border-b px-3 py-2">
                  {type.icon && (
                    <span aria-hidden className="text-sm">
                      {type.icon}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {type.name}
                  </span>
                  {multi && instances.length > 0 && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {instances.length}
                    </span>
                  )}
                </div>
                <div className="space-y-1 p-1.5">
                  {multi && instances.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      {t('cloudAsr.typeEmpty')}
                    </p>
                  )}
                  {instances.map((p) => {
                    const configured = isAsrProviderConfigured(p);
                    return (
                      <div
                        key={p.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          setSelectedId(p.id);
                          setTestResult(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedId(p.id);
                            setTestResult(null);
                          }
                        }}
                        className={cn(
                          'group flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm',
                          selectedId === p.id
                            ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/20'
                            : 'hover:bg-muted',
                        )}
                      >
                        <span
                          className="min-w-0 flex-1 truncate"
                          title={p.name}
                        >
                          {p.name}
                        </span>
                        {configured && (
                          <Badge
                            variant="outline"
                            className="shrink-0 border-success/40 px-1.5 py-0 text-[10px] text-success"
                          >
                            {t('cloudAsr.configured')}
                          </Badge>
                        )}
                        <button
                          type="button"
                          aria-label={commonT('delete')}
                          className="shrink-0 opacity-0 group-hover:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRemoveTarget(p);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                  {known &&
                    (multi ? (
                      presets.length > 0 ? (
                        // 协议型 + 有预设：下拉列出各 vendor 预设 + 「自定义」。
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-full justify-start gap-1.5 text-muted-foreground"
                            >
                              <Plus size={14} />
                              {t('cloudAsr.addInstance')}
                              <ChevronDown size={14} className="ml-auto" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start" className="w-56">
                            {presets.map((preset) => (
                              <DropdownMenuItem
                                key={preset.id}
                                onClick={() => handleAdd(type.id, preset.id)}
                              >
                                {preset.icon && (
                                  <span aria-hidden className="mr-1.5">
                                    {preset.icon}
                                  </span>
                                )}
                                {preset.name}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleAdd(type.id)}
                            >
                              <Plus size={14} className="mr-1.5" />
                              {t('cloudAsr.customPreset')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start gap-1.5 text-muted-foreground"
                          onClick={() => handleAdd(type.id)}
                        >
                          <Plus size={14} />
                          {t('cloudAsr.addInstance')}
                        </Button>
                      )
                    ) : instances.length === 0 ? (
                      // 品牌型单例：仅未配置时给「配置」入口；已配置则无「添加」（封顶 1）。
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start gap-1.5 text-muted-foreground"
                        onClick={() => handleAdd(type.id)}
                      >
                        <Plus size={14} />
                        {t('cloudAsr.configure')}
                      </Button>
                    ) : null)}
                </div>
              </div>
            );
          })}
        </div>

        {/* 选中实例表单 */}
        {selected && (
          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <Input
                value={selected.name}
                onChange={(e) => handleField('name', e.target.value)}
                className="h-9 max-w-xs font-medium"
                aria-label={t('cloudAsr.instanceName')}
              />
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 shrink-0"
                onClick={handleTest}
                disabled={testing}
              >
                {testing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="h-4 w-4" />
                )}
                {t('cloudAsr.testConnection')}
              </Button>
            </div>

            {selectedType && (
              <p className="-mt-2 text-xs text-muted-foreground">
                {selectedType.icon ? `${selectedType.icon} ` : ''}
                {selectedType.name}
              </p>
            )}

            {testResult && testResult.id === selected.id && (
              <div
                className={cn(
                  'rounded-md border px-3 py-2 text-sm',
                  testResult.ok
                    ? 'border-success/30 bg-success/5 text-success'
                    : 'border-destructive/30 bg-destructive/5 text-destructive',
                )}
              >
                {testResult.message}
              </div>
            )}

            <div className="grid gap-4">
              {(selectedType?.fields ?? []).map(renderField)}
            </div>
          </div>
        )}
      </div>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cloudAsr.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cloudAsr.removeDesc', { name: removeTarget?.name ?? '' })}
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
                if (removeTarget) handleRemove(removeTarget.id);
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

export default CloudAsrPanel;

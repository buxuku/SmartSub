/**
 * 「配音服务」右栏：单个在线服务商条目的配置面板
 * （形制 CloudProviderPanel：一条目一表单，动笔才物化；测试连接真实合成）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  FlaskConical,
  ListRestart,
  Loader2,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
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
import { cn, openUrl } from 'lib/utils';
import {
  buildTtsInstanceFromPreset,
  getBuiltinTtsVoiceLabels,
  isTtsProviderConfigured,
  parseTtsVoiceLabels,
  parseTtsVoices,
  resolveTtsVoiceLabel,
  type TtsEngineView,
  type TtsProvider,
  type TtsProviderField,
} from '../../../types/ttsProvider';

interface TtsProviderPanelProps {
  view: TtsEngineView;
  onUpdateField: (
    id: string,
    key: string,
    value: string | number | boolean,
  ) => void;
  onMaterialize: (typeId: string, presetId?: string) => string | null;
  onRemove: (id: string) => void;
}

const TtsProviderPanel: React.FC<TtsProviderPanelProps> = ({
  view,
  onUpdateField,
  onMaterialize,
  onRemove,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const { type, kind, preset, instance } = view;

  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [removeTarget, setRemoveTarget] = useState<TtsProvider | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingVoices, setFetchingVoices] = useState(false);
  // 音色标签录入的「输入中」草稿（回车/分隔符提交为标签，形制 ASR models 录入）。
  const [voiceDraft, setVoiceDraft] = useState('');
  // 自动补全高亮项（-1 = 未选中，回车按原文提交）。
  const [suggestIdx, setSuggestIdx] = useState(-1);
  // 展开中的 select 字段（可搜索 combobox，单面板同刻只开一个）。
  const [openSelectKey, setOpenSelectKey] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    setTestResult(null);
    setClearConfirmOpen(false);
    setVoiceDraft('');
    setSuggestIdx(-1);
  }, [view.viewId]);

  const defaults = useMemo(
    () => buildTtsInstanceFromPreset(type, preset),
    [type, preset],
  );

  const handleField = (key: string, value: string | number | boolean) => {
    if (instance) {
      onUpdateField(instance.id, key, value);
      return;
    }
    const id = onMaterialize(type.id, preset?.id);
    if (id) onUpdateField(id, key, value);
  };

  const handleTest = async () => {
    const target = instance ?? defaults;
    setTesting(true);
    setTestResult(null);
    try {
      const res = (await window?.ipc?.invoke('testTtsProvider', target)) as {
        ok?: boolean;
        needsConfig?: boolean;
        detail?: string;
      };
      if (res?.needsConfig) {
        setTestResult({ ok: false, message: t('cloudAsr.testNeedsConfig') });
      } else if (res?.ok) {
        setTestResult({ ok: true, message: t('dubbingBlock.testSuccess') });
        toast.success(t('dubbingBlock.testSuccess'));
        // 测试通过但尚未物化（Edge 等默认值即可用的类型）：顺手落库，
        // 配音工作台的引擎下拉才能列出该服务商。
        if (!instance) onMaterialize(type.id, preset?.id);
      } else {
        setTestResult({
          ok: false,
          message: res?.detail
            ? `${t('cloudAsr.testFailed')} ${res.detail}`
            : t('cloudAsr.testFailed'),
        });
      }
    } catch {
      setTestResult({ ok: false, message: t('cloudAsr.testFailed') });
    } finally {
      setTesting(false);
    }
  };

  /** 零凭据类型（Edge）：显式「启用」即物化实例（默认值即已配置）。 */
  const handleEnable = () => {
    onMaterialize(type.id, preset?.id);
    toast.success(t('ttsServices.enabled'));
  };

  /**
   * 在线拉取音色（voiceListMode 类型）：
   * - replace（ElevenLabs）：清单替换为账号实际可用集 + 回填 id→名称映射；
   * - label（Azure，区域全量 700+）：仅回填名称映射，不动当前清单。
   * 标签与工作台下拉均按名称展示。
   */
  const handleFetchVoices = async () => {
    const target = instance ?? defaults;
    setFetchingVoices(true);
    try {
      const res = (await window?.ipc?.invoke('listTtsVoices', target)) as {
        ok?: boolean;
        voices?: Array<{ id: string; name: string }>;
        detail?: string;
      };
      if (res?.ok && res.voices?.length) {
        const id = instance?.id ?? onMaterialize(type.id, preset?.id);
        if (!id) return;
        if (type.voiceListMode === 'replace') {
          onUpdateField(id, 'voices', res.voices.map((v) => v.id).join(', '));
        }
        onUpdateField(
          id,
          'voiceLabels',
          JSON.stringify(
            Object.fromEntries(res.voices.map((v) => [v.id, v.name])),
          ),
        );
        toast.success(
          type.voiceListMode === 'replace'
            ? t('ttsServices.fetchVoicesDone', { count: res.voices.length })
            : t('ttsServices.fetchVoicesLabeled', {
                count: res.voices.length,
              }),
        );
      } else {
        toast.error(
          res?.detail
            ? `${t('ttsServices.fetchVoicesFailed')} ${res.detail}`
            : t('ttsServices.fetchVoicesFailed'),
        );
      }
    } catch {
      toast.error(t('ttsServices.fetchVoicesFailed'));
    } finally {
      setFetchingVoices(false);
    }
  };

  /** 当前音色清单：未物化时按默认值（含预设预填）展示。 */
  const currentVoices = (): string[] => parseTtsVoices(instance ?? defaults);

  const writeVoices = (voices: string[]) => {
    handleField('voices', voices.join(', '));
  };

  /** 把草稿按分隔符拆成标签并入清单（去空去重），供回车/分隔符/失焦提交。 */
  const commitVoiceDraft = (raw: string) => {
    const current = currentVoices();
    const pieces = raw
      .split(/[,，、;；\s]+/)
      .map((v) => v.trim())
      .filter(Boolean)
      .filter((v) => !current.includes(v));
    if (pieces.length) writeVoices([...current, ...pieces]);
    setVoiceDraft('');
  };

  /**
   * 音色清单标签录入（数据仍存规范逗号串，仅录入交互结构化，形制 ASR models）。
   * 名称映射 = 实例拉取的 voiceLabels ∪ 类型内置目录（豆包/ElevenLabs 预填集），
   * 输入草稿按「名称/ID 包含匹配」出自动补全，上下键选择、回车录入
   * （未选中项时回车按原文提交）。
   */
  const renderVoicesField = () => {
    const voices = currentVoices();
    const labelSource = instance ?? defaults;
    const labelMap = {
      ...getBuiltinTtsVoiceLabels(type.id),
      ...parseTtsVoiceLabels(labelSource),
    };
    const hasLabels =
      Boolean(type.voiceListMode) || Object.keys(labelMap).length > 0;

    const q = voiceDraft.trim().toLowerCase();
    const suggestions = q
      ? Object.entries(labelMap)
          .filter(
            ([id, name]) =>
              !voices.includes(id) &&
              (id.toLowerCase().includes(q) || name.toLowerCase().includes(q)),
          )
          .slice(0, 12)
      : [];

    const addVoice = (id: string) => {
      if (!voices.includes(id)) writeVoices([...voices, id]);
      setVoiceDraft('');
      setSuggestIdx(-1);
    };

    return (
      <div className="relative">
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
          {voices.map((v) => {
            const label = hasLabels ? resolveTtsVoiceLabel(labelSource, v) : v;
            return (
              <Badge
                key={v}
                variant="secondary"
                className="gap-1 font-mono"
                title={label === v ? undefined : v}
              >
                {label}
                <button
                  type="button"
                  aria-label={commonT('delete')}
                  onClick={() => writeVoices(voices.filter((x) => x !== v))}
                >
                  <X size={12} />
                </button>
              </Badge>
            );
          })}
          <input
            value={voiceDraft}
            onChange={(e) => {
              const v = e.target.value;
              // 输入任一分隔符（含全角）即时成标签，杜绝逗号串手拼。
              if (/[,，、;；]/.test(v)) commitVoiceDraft(v);
              else setVoiceDraft(v);
              setSuggestIdx(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && suggestions.length > 0) {
                e.preventDefault();
                setSuggestIdx((i) => (i + 1) % suggestions.length);
              } else if (e.key === 'ArrowUp' && suggestions.length > 0) {
                e.preventDefault();
                setSuggestIdx(
                  (i) => (i - 1 + suggestions.length) % suggestions.length,
                );
              } else if (e.key === 'Escape') {
                setSuggestIdx(-1);
                setVoiceDraft('');
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (suggestIdx >= 0 && suggestions[suggestIdx]) {
                  addVoice(suggestions[suggestIdx][0]);
                } else if (suggestions.length === 1) {
                  addVoice(suggestions[0][0]);
                } else {
                  commitVoiceDraft(voiceDraft);
                }
              } else if (
                e.key === 'Backspace' &&
                !voiceDraft &&
                voices.length > 0
              ) {
                writeVoices(voices.slice(0, -1));
              }
            }}
            onBlur={() => {
              // 点击补全项走 onMouseDown（先于 blur），此处仅兜底提交草稿。
              commitVoiceDraft(voiceDraft);
              setSuggestIdx(-1);
            }}
            placeholder={t('ttsServices.voicesAddHint')}
            className="min-w-28 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {suggestions.length > 0 && (
          <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover py-1 shadow-md">
            {suggestions.map(([id, name], i) => (
              <li key={id}>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted/60',
                    i === suggestIdx && 'bg-muted/60',
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addVoice(id);
                  }}
                >
                  <span className="truncate">{name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {id}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const renderField = (field: TtsProviderField) => {
    const value = instance?.[field.key] ?? defaults[field.key] ?? '';
    const label = t(field.label, { defaultValue: field.label });
    const placeholder = field.placeholder
      ? t(field.placeholder, { defaultValue: field.placeholder })
      : undefined;

    return (
      <div key={field.key} className="space-y-1.5">
        <label className="text-sm font-medium">
          {label}
          {field.required && <span className="text-destructive"> *</span>}
        </label>
        {field.key === 'voices' ? (
          renderVoicesField()
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
        ) : field.type === 'select' ? (
          // 可搜索 combobox（区域等长枚举，打字过滤快速定位）。
          <Popover
            open={openSelectKey === field.key}
            onOpenChange={(open) => setOpenSelectKey(open ? field.key : null)}
          >
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={openSelectKey === field.key}
                // 与 Input 同宽同排版（全宽一行、px-3），仅右侧多一枚展开箭头。
                className="w-full justify-between px-3 font-mono font-normal"
              >
                {String(value) || placeholder || ''}
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[--radix-popover-trigger-width] p-0"
              align="start"
            >
              <Command>
                <CommandInput placeholder={t('ttsServices.searchOption')} />
                <CommandList>
                  <CommandEmpty>{t('ttsServices.noOptionMatch')}</CommandEmpty>
                  {(field.options ?? []).map((opt) => (
                    <CommandItem
                      key={opt}
                      value={opt}
                      className="font-mono"
                      onSelect={() => {
                        handleField(field.key, opt);
                        setOpenSelectKey(null);
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4',
                          String(value) === opt ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      {opt}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
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
        {field.tips && (
          <p className="text-xs text-muted-foreground">
            {t(field.tips, { defaultValue: '' })}
          </p>
        )}
      </div>
    );
  };

  const removeDialog = (
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
              if (removeTarget) onRemove(removeTarget.id);
              setRemoveTarget(null);
            }}
          >
            <Trash2 className="h-4 w-4" />
            {commonT('delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (kind === 'orphan') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t('cloudAsr.orphanHint')}
        </p>
        {(view.orphanInstances ?? []).map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate" title={p.name}>
              {p.name}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={commonT('delete')}
              onClick={() => setRemoveTarget(p)}
            >
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
        {removeDialog}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('dubbingBlock.providersIntro')}
        </p>
      </div>

      {view.unstable && (
        <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('dubbingBlock.edgeHint')}
        </p>
      )}

      <div className="flex items-center justify-end gap-1.5">
        {/* 音色/语音库官方文档外链 */}
        {type.docsUrl && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => openUrl(type.docsUrl!)}
          >
            <ExternalLink className="h-4 w-4" />
            {t('ttsServices.voiceDocs')}
          </Button>
        )}
        {kind === 'custom' && instance && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-destructive"
            onClick={() => setRemoveTarget(instance)}
          >
            <Trash2 className="h-4 w-4" />
            {commonT('delete')}
          </Button>
        )}
        {kind !== 'custom' && instance && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-destructive"
            onClick={() => setClearConfirmOpen(true)}
          >
            <Eraser className="h-4 w-4" />
            {t('cloudAsr.clearConfig')}
          </Button>
        )}
        {/* 在线拉取音色清单（voiceListMode 类型：ElevenLabs/Azure） */}
        {type.voiceListMode && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={handleFetchVoices}
            disabled={fetchingVoices}
          >
            {fetchingVoices ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ListRestart className="h-4 w-4" />
            )}
            {t('ttsServices.fetchVoices')}
          </Button>
        )}
        {/* 零凭据类型（Edge）默认值即可用，但需显式启用落库才进工作台引擎下拉 */}
        {!instance && isTtsProviderConfigured(defaults, type) && (
          <Button size="sm" className="shrink-0 gap-1.5" onClick={handleEnable}>
            <Plus className="h-4 w-4" />
            {t('ttsServices.enable')}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
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

      {testResult && (
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
        {kind === 'custom' && instance && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('cloudAsr.instanceName')}
            </label>
            <Input
              value={instance.name}
              onChange={(e) => handleField('name', e.target.value)}
              className="max-w-xs"
            />
          </div>
        )}
        {type.fields.map(renderField)}
      </div>

      {removeDialog}

      <AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('cloudAsr.clearConfigTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('cloudAsr.clearConfigDesc', { name: view.label })}
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
                if (instance) onRemove(instance.id);
                setClearConfirmOpen(false);
              }}
            >
              <Eraser className="h-4 w-4" />
              {t('cloudAsr.clearConfig')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TtsProviderPanel;

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Eraser,
  Eye,
  EyeOff,
  FlaskConical,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
  parseAsrModels,
  type AsrProvider,
  type AsrProviderField,
  type CloudEngineView,
} from '../../../../../types/asrProvider';

interface CloudProviderPanelProps {
  /** 左栏选中的云条目（品牌单例 / 预设槽位 / 自定义实例 / 孤儿类型）。 */
  view: CloudEngineView;
  /** 更新实例字段（debounce 持久化，见 useAsrProviders）。 */
  onUpdateField: (
    id: string,
    key: string,
    value: string | number | boolean,
  ) => void;
  /** 惰性物化实例（预设槽位带 presetId 标记），返回新实例 id。 */
  onMaterialize: (typeId: string, presetId?: string) => string | null;
  /** 删除实例（自定义条目删除后由父级收敛选中视图）。 */
  onRemove: (id: string) => void;
}

/**
 * 单个云条目的右栏配置面板（redesign-engine-panel-layout，方案 Y）：
 * 一条目 = 一张表单，零实例管理概念。
 * - 品牌单例 / 预设槽位：表单直显，首次编辑惰性物化唯一实例（预设槽位打
 *   presetId 标记）；「清除配置」（带确认）抹除凭据回未配置，条目保留。
 * - 自定义实例：表单直显 + 可改名；「删除」（带确认）移除整个条目。
 * - 孤儿类型（类型已下线）：仅实例名列表 + 删除。
 * 字段渲染 / 模型录入 / 测试连接沿用既有逻辑。
 */
const CloudProviderPanel: React.FC<CloudProviderPanelProps> = ({
  view,
  onUpdateField,
  onMaterialize,
  onRemove,
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const { type, kind, preset, instance } = view;

  // 自由型模型标签录入的「输入中」草稿（回车/分隔符提交为标签，避免逗号手拼）。
  const [modelDraft, setModelDraft] = useState('');
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [removeTarget, setRemoveTarget] = useState<AsrProvider | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // 切换条目时重置局部交互态。
  useEffect(() => {
    setModelDraft('');
    setTestResult(null);
    setClearConfirmOpen(false);
  }, [view.viewId]);

  /** 未物化时表单展示的默认值（类型默认 + 预设预填）。 */
  const defaults = useMemo(
    () => buildInstanceFromPreset(type, preset),
    [type, preset],
  );

  /**
   * 字段写入统一入口：无实例时先惰性物化（预设槽位带 presetId）再应用本次
   * 编辑——「打开面板不落库，动笔才落库」。
   */
  const handleField = (key: string, value: string | number | boolean) => {
    if (instance) {
      onUpdateField(instance.id, key, value);
      return;
    }
    const id = onMaterialize(type.id, preset?.id);
    if (id) onUpdateField(id, key, value);
  };

  const handleTest = async () => {
    // 未物化的条目用默认值临时实例自测（凭据为空 → 返回 needsConfig 提示）。
    const target = instance ?? defaults;
    setTesting(true);
    setTestResult(null);
    try {
      // 连通性自测跑在主进程（规避渲染进程 CORS），按服务商类型选鉴权端点。
      const res = (await window?.ipc?.invoke('testAsrProvider', target)) as {
        ok?: boolean;
        status?: number;
        needsConfig?: boolean;
        detail?: string;
      };
      if (res?.needsConfig) {
        setTestResult({ ok: false, message: t('cloudAsr.testNeedsConfig') });
      } else if (res?.ok) {
        setTestResult({ ok: true, message: t('cloudAsr.testSuccess') });
        toast.success(t('cloudAsr.testSuccess'));
      } else {
        // 优先展示服务端 detail（如「缺少 speech_to_text 权限」），否则回落状态码/通用文案。
        const base = res?.status
          ? t('cloudAsr.testFailedStatus', { status: res.status })
          : t('cloudAsr.testFailed');
        setTestResult({
          ok: false,
          message: res?.detail ? `${base} ${res.detail}` : base,
        });
      }
    } catch {
      setTestResult({ ok: false, message: t('cloudAsr.testFailed') });
    } finally {
      setTesting(false);
    }
  };

  /** 当前模型清单：未物化时按默认值（含预设预填）展示。 */
  const currentModels = (): string[] => parseAsrModels(instance ?? defaults);

  const writeModels = (models: string[]) => {
    handleField('models', models.join(', '));
  };

  /** 把草稿按分隔符拆成标签并入清单（去空去重），供回车/分隔符/失焦提交。 */
  const commitModelDraft = (raw: string) => {
    const current = currentModels();
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
    const models = currentModels();
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

  /**
   * 字段说明文案：协议型预设槽位（OpenAI / Groq / 硅基流动）优先取
   * `<tipsKey>_<presetId>` 的平台专属文案（带各家注册/控制台链接），缺失回落通用文案。
   */
  const resolveTips = (field: AsrProviderField): string | undefined => {
    if (!field.tips) return undefined;
    if (preset) {
      const presetTips = t(`${field.tips}_${preset.id}`, { defaultValue: '' });
      if (presetTips) return presetTips;
    }
    return t(field.tips, { defaultValue: field.tips });
  };

  const renderField = (field: AsrProviderField) => {
    const value = instance?.[field.key] ?? defaults[field.key] ?? '';
    const label = t(field.label, { defaultValue: field.label });
    const placeholder = field.placeholder
      ? t(field.placeholder, { defaultValue: field.placeholder })
      : undefined;
    const tips = resolveTips(field);

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
        {tips && (
          // 与翻译服务商表单一致：说明支持内嵌 <a> 链接，点击经主进程用系统浏览器打开
          <p
            className="text-xs text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: tips }}
            onClick={(e) => {
              const target = e.target as HTMLElement;
              if (target.tagName === 'A') {
                e.preventDefault();
                const url = target.getAttribute('href');
                if (url) window?.ipc?.send('openUrl', url);
              }
            }}
          />
        )}
      </div>
    );
  };

  const testResultBox = testResult && (
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
  );

  const testButton = (
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
  );

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

  // 孤儿类型：类型定义已下线，仅保数据可见可删。
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

  // 品牌单例 / 预设槽位 / 自定义实例：统一「一条目一表单」直显。
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('cloudAsr.intro')}
        </p>
      </div>

      <div className="flex items-center justify-end gap-1.5">
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
        {testButton}
      </div>
      {testResultBox}

      <div className="grid gap-4">
        {/* 自定义条目可改名（名称即侧栏条目与任务页下拉的显示名） */}
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

      {/* 「清除配置」确认：删除条目背后的实例，表单回落默认值，条目保留 */}
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

export default CloudProviderPanel;

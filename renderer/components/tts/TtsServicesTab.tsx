/**
 * 「配音服务」主从双栏（形制 EngineModelTab）：
 * 左栏 =「总览」首项 + 「本地模型」「在线服务」「我的音色」三组——本地 = 每个
 * TTS 模型一个条目；在线 = 每个服务商预设/实例一个平级入口（OpenAI / 硅基流动 /
 * Edge TTS + 自定义），数据驱动自 TTS_PROVIDER_TYPES / TTS_PROVIDER_PRESETS；
 * 我的音色 = 每个克隆音色一个条目。列表体只做导航选择，添加类操作收敛为每组
 * 末尾一个入口（在线服务 =「添加自定义服务」；我的音色 =「添加音色」下拉菜单：
 * 创建 / 导入 / 从平台取回）。右栏 = 选中条目的管理面板；「总览」= 新手落地页。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ChevronDown,
  CloudDownload,
  HardDriveUpload,
  LayoutGrid,
  Mic2,
  Plus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import { Panel, PanelHeader } from '@/components/ui/panel';
import useLocalStorageState from 'hooks/useLocalStorageState';
import useTtsProviders from 'hooks/useTtsProviders';
import useClonedVoices from 'hooks/useClonedVoices';
import useTtsModels from './useTtsModels';
import TtsModelPanel from './TtsModelPanel';
import TtsProviderPanel from './TtsProviderPanel';
import ClonedVoicePanel from './ClonedVoicePanel';
import TtsOverviewPanel from './TtsOverviewPanel';
import CloneVoiceWizard from '../voiceClone/CloneVoiceWizard';
import LinkCloudVoiceDialog from '../voiceClone/LinkCloudVoiceDialog';
import {
  TTS_OPENAI_COMPATIBLE,
  TTS_VIEW_PREFIX,
  buildTtsViews,
  ttsCustomViewId,
  ttsViewTypeId,
} from '../../../types/ttsProvider';

const OVERVIEW_VIEW = 'overview';
const MODEL_VIEW_PREFIX = 'model:';
const CLONE_VIEW_PREFIX = 'clone:';

function isTtsServicesViewId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return (
    value === OVERVIEW_VIEW ||
    value.startsWith(MODEL_VIEW_PREFIX) ||
    value.startsWith(TTS_VIEW_PREFIX) ||
    value.startsWith(CLONE_VIEW_PREFIX)
  );
}

function StatusDot({ ready, label }: { ready: boolean; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        ready ? 'bg-success' : 'bg-muted-foreground/40',
      )}
    />
  );
}

const TtsServicesTab: React.FC = () => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');
  const { t: cloneT } = useTranslation('voiceClone');

  const modelsApi = useTtsModels();
  const tts = useTtsProviders();
  const clones = useClonedVoices();

  const [selectedView, setSelectedView] = useLocalStorageState<string>(
    'ttsServicesSelectedView',
    OVERVIEW_VIEW,
    isTtsServicesViewId,
  );

  const [addCustomOpen, setAddCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customApiUrl, setCustomApiUrl] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const providerViews = useMemo(
    () => buildTtsViews(tts.providers),
    [tts.providers],
  );

  const activeModel = selectedView.startsWith(MODEL_VIEW_PREFIX)
    ? modelsApi.models.find(
        (m) => m.id === selectedView.slice(MODEL_VIEW_PREFIX.length),
      )
    : undefined;
  const activeProviderView = providerViews.find(
    (v) => v.viewId === selectedView,
  );
  const activeClone = selectedView.startsWith(CLONE_VIEW_PREFIX)
    ? clones.voices.find(
        (v) => v.id === selectedView.slice(CLONE_VIEW_PREFIX.length),
      )
    : undefined;

  // 选中态收敛：失效的 tts:*（自定义被删/类型下线）回落同类型首条目，
  // 无同类再回落首个模型条目；失效的 model:* / clone:* 回落首个模型；
  // 「总览」恒有效，不参与收敛。
  useEffect(() => {
    if (!tts.loaded || !modelsApi.loaded || !clones.loaded) return;
    if (selectedView === OVERVIEW_VIEW) return;
    if (selectedView.startsWith(MODEL_VIEW_PREFIX)) {
      if (!activeModel && modelsApi.models.length > 0) {
        setSelectedView(`${MODEL_VIEW_PREFIX}${modelsApi.models[0].id}`);
      }
      return;
    }
    if (selectedView.startsWith(CLONE_VIEW_PREFIX)) {
      if (!activeClone) {
        setSelectedView(
          clones.voices[0]
            ? `${CLONE_VIEW_PREFIX}${clones.voices[0].id}`
            : modelsApi.models[0]
              ? `${MODEL_VIEW_PREFIX}${modelsApi.models[0].id}`
              : selectedView,
        );
      }
      return;
    }
    if (activeProviderView) return;
    const typeId = ttsViewTypeId(selectedView);
    const sameType = typeId
      ? providerViews.find((v) => v.type.id === typeId)
      : undefined;
    setSelectedView(
      sameType?.viewId ??
        (modelsApi.models[0]
          ? `${MODEL_VIEW_PREFIX}${modelsApi.models[0].id}`
          : (providerViews[0]?.viewId ?? selectedView)),
    );
  }, [
    tts.loaded,
    modelsApi.loaded,
    clones.loaded,
    clones.voices,
    modelsApi.models,
    selectedView,
    activeModel,
    activeProviderView,
    activeClone,
    providerViews,
    setSelectedView,
  ]);

  const handleAddCustom = () => {
    const id = tts.addCustomInstance(
      TTS_OPENAI_COMPATIBLE,
      customName,
      customApiUrl,
    );
    setAddCustomOpen(false);
    setCustomName('');
    setCustomApiUrl('');
    if (id) setSelectedView(ttsCustomViewId(TTS_OPENAI_COMPATIBLE, id));
  };

  const handleImportVoice = async () => {
    const r = await clones.importVoice();
    if (r?.success && r.data?.name) {
      toast.success(cloneT('importDone', { name: r.data.name }));
      setSelectedView(`${CLONE_VIEW_PREFIX}${r.data.id}`);
    } else if (r && r.success === false && r.error) {
      toast.error(r.error);
    }
  };

  const readyBadge = (
    <Badge variant="outline" className="border-success/40 text-success">
      {t('engines.statusAvailable')}
    </Badge>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className="grid h-full min-h-0 grid-cols-1 gap-2.5 overflow-hidden md:grid-cols-[248px_minmax(0,1fr)]">
        <Panel className="min-h-0 overflow-hidden">
          <PanelHeader
            title={t('ttsServices.masterTitle')}
            actions={
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t('ttsServices.addCustom')}
                onClick={() => setAddCustomOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            }
          />
          <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
            {/* 总览（默认落地视图，不属于任何分组） */}
            <button
              type="button"
              aria-current={selectedView === OVERVIEW_VIEW ? 'true' : undefined}
              onClick={() => setSelectedView(OVERVIEW_VIEW)}
              className={cn(
                'relative flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] transition-colors',
                selectedView === OVERVIEW_VIEW
                  ? 'bg-primary/10 font-medium text-primary before:absolute before:inset-y-2 before:-left-1.5 before:w-[3px] before:rounded-r-full before:bg-primary'
                  : 'text-foreground hover:bg-accent',
              )}
            >
              <span
                className={cn(
                  'flex h-6 w-6 flex-none items-center justify-center rounded-md',
                  selectedView === OVERVIEW_VIEW
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{t('ttsServices.overview')}</span>
                <span className="truncate text-[11px] font-normal text-muted-foreground">
                  {t('ttsServices.overviewSubtitle')}
                </span>
              </span>
            </button>

            {/* 本地模型组 */}
            <div className="label-caps px-2 pb-1 pt-2.5">
              {t('ttsServices.groupLocal')}
            </div>
            {modelsApi.models.map((m) => {
              const viewId = `${MODEL_VIEW_PREFIX}${m.id}`;
              const active = selectedView === viewId;
              return (
                <button
                  key={viewId}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setSelectedView(viewId)}
                  className={cn(
                    'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                    active
                      ? 'bg-primary/10 font-medium text-primary before:absolute before:inset-y-1.5 before:-left-1.5 before:w-[3px] before:rounded-r-full before:bg-primary'
                      : 'text-foreground hover:bg-accent',
                  )}
                >
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-base">
                    💻
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={m.displayName}
                  >
                    {m.displayName}
                  </span>
                  <StatusDot
                    ready={m.installed}
                    label={
                      m.installed
                        ? t('dubbingBlock.installed')
                        : t('engines.status.pending')
                    }
                  />
                </button>
              );
            })}

            {/* 在线服务组：每个服务商一个平级入口 + 添加自定义 */}
            <div className="label-caps px-2 pb-1 pt-2.5">
              {t('ttsServices.groupCloud')}
            </div>
            {providerViews.map((v) => {
              const active = selectedView === v.viewId;
              return (
                <button
                  key={v.viewId}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setSelectedView(v.viewId)}
                  className={cn(
                    'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                    active
                      ? 'bg-primary/10 font-medium text-primary before:absolute before:inset-y-1.5 before:-left-1.5 before:w-[3px] before:rounded-r-full before:bg-primary'
                      : 'text-foreground hover:bg-accent',
                  )}
                >
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-base">
                    {v.icon ?? '☁️'}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={v.label}>
                    {v.label}
                  </span>
                  {v.unstable && (
                    <span className="shrink-0 rounded bg-warning/15 px-1 text-[10px] leading-4 text-warning">
                      {t('dubbingBlock.unstable')}
                    </span>
                  )}
                  <StatusDot
                    ready={v.configured}
                    label={
                      v.configured
                        ? t('engines.statusAvailable')
                        : t('engines.status.pending')
                    }
                  />
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setAddCustomOpen(true)}
              className="flex w-full items-center gap-2 rounded-md border border-dashed border-border-strong px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
                <Plus className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {t('ttsServices.addCustom')}
              </span>
            </button>

            {/* 我的音色组：克隆音色逐条 + 单一「添加音色」入口（创建/导入/取回三合一） */}
            <div className="label-caps px-2 pb-1 pt-2.5">
              {cloneT('groupMyVoices')}
            </div>
            {clones.voices.map((v) => {
              const viewId = `${CLONE_VIEW_PREFIX}${v.id}`;
              const active = selectedView === viewId;
              const ready =
                v.engine === 'zipvoice' ? true : v.trainStatus === 'ready';
              return (
                <button
                  key={viewId}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setSelectedView(viewId)}
                  className={cn(
                    'relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                    active
                      ? 'bg-primary/10 font-medium text-primary before:absolute before:inset-y-1.5 before:-left-1.5 before:w-[3px] before:rounded-r-full before:bg-primary'
                      : 'text-foreground hover:bg-accent',
                  )}
                >
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
                    <Mic2 className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={v.name}>
                    {v.name}
                  </span>
                  <StatusDot
                    ready={ready}
                    label={ready ? cloneT('trainReady') : cloneT('training')}
                  />
                </button>
              );
            })}
            {/* 添加音色：三种获得方式收敛为一个入口（创建 / 导入 / 从平台取回） */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md border border-dashed border-border-strong px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
                    <Plus className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {cloneT('addVoice')}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[--radix-dropdown-menu-trigger-width] min-w-48"
              >
                <DropdownMenuItem
                  className="gap-2"
                  onSelect={() => setWizardOpen(true)}
                >
                  <Mic2 className="h-4 w-4" />
                  <div className="min-w-0">
                    <p>{cloneT('createVoice')}</p>
                    <p className="text-xs text-muted-foreground">
                      {cloneT('createVoiceHint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  onSelect={handleImportVoice}
                >
                  <HardDriveUpload className="h-4 w-4" />
                  <div className="min-w-0">
                    <p>{cloneT('importVoicePack')}</p>
                    <p className="text-xs text-muted-foreground">
                      {cloneT('importVoiceHint')}
                    </p>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2"
                  onSelect={() => setLinkOpen(true)}
                >
                  <CloudDownload className="h-4 w-4" />
                  <div className="min-w-0">
                    <p>{cloneT('linkEntry')}</p>
                    <p className="text-xs text-muted-foreground">
                      {cloneT('linkEntryHint')}
                    </p>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>
        </Panel>

        {/* 右栏 */}
        <Panel className="min-h-0 overflow-hidden">
          <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold leading-tight">
                {selectedView === OVERVIEW_VIEW
                  ? t('ttsServices.overview')
                  : activeModel
                    ? activeModel.displayName
                    : activeClone
                      ? activeClone.name
                      : (activeProviderView?.kind === 'brand'
                          ? activeProviderView.type.name
                          : activeProviderView?.label) || ''}
              </h2>
              {selectedView === OVERVIEW_VIEW && (
                <p className="text-xs text-muted-foreground">
                  {t('ttsServices.overviewSubtitle')}
                </p>
              )}
              {activeProviderView &&
                (activeProviderView.kind === 'preset' ||
                  activeProviderView.kind === 'custom') && (
                  <p className="text-xs text-muted-foreground">
                    {activeProviderView.type.name}
                  </p>
                )}
              {activeModel && (
                <p className="text-xs text-muted-foreground">
                  {t('ttsServices.localSubtitle')}
                </p>
              )}
              {activeClone && (
                <p className="text-xs text-muted-foreground">
                  {activeClone.engine === 'zipvoice'
                    ? cloneT('engineZipvoice')
                    : activeClone.engine === 'elevenlabs'
                      ? cloneT('engineElevenlabs')
                      : cloneT('engineVolcengine')}
                </p>
              )}
            </div>
            {activeModel ? (
              activeModel.installed ? (
                readyBadge
              ) : (
                <Badge
                  variant="outline"
                  className="border-primary/40 text-primary"
                >
                  {t('engines.fasterWhisper.notInstalled')}
                </Badge>
              )
            ) : activeClone ? (
              readyBadge
            ) : activeProviderView ? (
              activeProviderView.configured ? (
                readyBadge
              ) : (
                <Badge
                  variant="outline"
                  className="border-primary/40 text-primary"
                >
                  {t('engines.cloud.notConfigured')}
                </Badge>
              )
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {selectedView === OVERVIEW_VIEW ? (
              <TtsOverviewPanel
                models={modelsApi.models}
                providerViews={providerViews}
                voices={clones.voices}
                onOpenModel={(id) =>
                  setSelectedView(`${MODEL_VIEW_PREFIX}${id}`)
                }
                onOpenProviderView={setSelectedView}
                onOpenClone={(id) =>
                  setSelectedView(`${CLONE_VIEW_PREFIX}${id}`)
                }
                onCreateVoice={() => setWizardOpen(true)}
              />
            ) : activeModel ? (
              <TtsModelPanel
                model={activeModel}
                onUpdate={modelsApi.refresh}
                onCreateVoice={() => setWizardOpen(true)}
              />
            ) : activeClone ? (
              <ClonedVoicePanel
                voice={activeClone}
                onRename={clones.rename}
                onRemove={clones.remove}
                onRegenerateSample={clones.regenerateSample}
                onVolcRefreshStatus={clones.volcRefreshStatus}
                onVolcRetrain={clones.volcRetrain}
                onExport={clones.exportVoice}
              />
            ) : activeProviderView ? (
              <TtsProviderPanel
                view={activeProviderView}
                onUpdateField={tts.updateInstanceField}
                onMaterialize={tts.addInstance}
                onRemove={tts.removeInstance}
              />
            ) : null}
          </div>
        </Panel>
      </div>

      {/* 创建克隆音色向导 */}
      <CloneVoiceWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={(voice) => {
          clones.refresh();
          setSelectedView(`${CLONE_VIEW_PREFIX}${voice.id}`);
        }}
      />

      <LinkCloudVoiceDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onListCloud={clones.listCloudVoices}
        onLink={clones.linkCloudVoice}
        onLinked={(voice) => {
          toast.success(cloneT('linkDone', { name: voice.name }));
          setSelectedView(`${CLONE_VIEW_PREFIX}${voice.id}`);
        }}
      />

      {/* 添加自定义 OpenAI 兼容 TTS 实例 */}
      <Dialog open={addCustomOpen} onOpenChange={setAddCustomOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('ttsServices.addCustom')}</DialogTitle>
            <DialogDescription>
              {t('ttsServices.addCustomDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label htmlFor="tts-custom-name" className="text-sm font-medium">
                {t('cloudAsr.instanceName')}
                <span className="text-destructive"> *</span>
              </label>
              <Input
                id="tts-custom-name"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customName.trim()) handleAddCustom();
                }}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="tts-custom-url" className="text-sm font-medium">
                {t('cloudAsr.baseUrlOptional')}
              </label>
              <Input
                id="tts-custom-url"
                value={customApiUrl}
                onChange={(e) => setCustomApiUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setAddCustomOpen(false);
                setCustomName('');
                setCustomApiUrl('');
              }}
            >
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </Button>
            <Button
              className="gap-1.5"
              disabled={!customName.trim()}
              onClick={handleAddCustom}
            >
              <Plus className="h-4 w-4" />
              {t('ttsServices.addCustom')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
};

export default TtsServicesTab;

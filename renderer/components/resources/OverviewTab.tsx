import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Bot,
  Languages,
  Zap,
  ArrowRight,
  AlertTriangle,
  Plus,
  Gauge,
  Cpu,
  CheckCircle2,
} from 'lucide-react';
import DownModel from '@/components/DownModel';
import DownModelButton from '@/components/DownModelButton';
import { modelCategories, getRecommendedCategory, cn } from 'lib/utils';
import useLocalStorageState from 'hooks/useLocalStorageState';
import { isProviderConfigured } from 'lib/providerUtils';
import IconChip from '@/components/IconChip';
import {
  getInstalledModelsForEngine,
  hasModelsForEngine,
} from 'lib/engineModels';
import { CardDecor } from '@/components/launchpad/TaskIcons';
import { ISystemInfo } from '../../../types/types';
import { Provider } from '../../../types';
import {
  deriveGpuDisplayState,
  type GpuDisplayState,
} from '@/components/settings/gpu/gpuDisplayState';
import { DownSource } from 'lib/modelPanelUtils';

const GPU_MODE_KEYS = ['auto', 'gpu-only', 'cpu-only'] as const;

const OVERVIEW_CARD_DECOR = {
  models: 'text-sky-500/[0.09] dark:text-sky-400/[0.12]',
  providers: 'text-emerald-500/[0.09] dark:text-emerald-400/[0.12]',
  acceleration: 'text-indigo-500/[0.09] dark:text-indigo-400/[0.12]',
  engines: 'text-amber-500/[0.09] dark:text-amber-400/[0.12]',
} as const;

const ENGINE_LABEL_KEYS = {
  builtin: 'overview.engineBuiltin',
  fasterWhisper: 'overview.engineFasterWhisper',
  localCli: 'overview.engineLocalCli',
} as const;

const OverviewTab = ({
  onNavigateTab,
}: {
  onNavigateTab: (tab: string) => void;
}) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');
  const [systemInfo, setSystemInfo] = useState<ISystemInfo>({
    modelsInstalled: [],
    downloadingModels: [],
    modelsPath: '',
  });
  const [providers, setProviders] = useState<Provider[]>([]);
  const [gpuState, setGpuState] = useState<GpuDisplayState | null>(null);
  const [downSource] = useLocalStorageState<DownSource>(
    'downSource',
    DownSource.HuggingFace,
    (val) => Object.values(DownSource).includes(val as DownSource),
  );

  const refresh = useCallback(async () => {
    try {
      const info = await window?.ipc?.invoke('getSystemInfo', null);
      if (info) setSystemInfo(info);
      const storedProviders = await window?.ipc?.invoke(
        'getTranslationProviders',
      );
      setProviders(storedProviders || []);

      const env = await window?.ipc?.invoke('get-gpu-environment');
      const settings = await window?.ipc?.invoke('getSettings');
      const active = await window?.ipc?.invoke('get-active-backend');
      const selected = await window?.ipc?.invoke('get-selected-addon-version');
      const customPath = await window?.ipc?.invoke('get-custom-addon-path');
      if (env) {
        setGpuState(
          deriveGpuDisplayState(
            env,
            settings?.gpuMode || 'auto',
            active,
            selected,
            customPath,
          ),
        );
      }
    } catch (error) {
      console.error('Failed to refresh overview:', error);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unsubProgress = window?.ipc?.on(
      'downloadProgress',
      (_model: string, progress: number) => {
        if (progress >= 1) refresh();
      },
    );
    const unsubBackend = window?.ipc?.on('active-backend-changed', () =>
      refresh(),
    );
    window.addEventListener('gpu-settings-changed', refresh);
    return () => {
      unsubProgress?.();
      unsubBackend?.();
      window.removeEventListener('gpu-settings-changed', refresh);
    };
  }, [refresh]);

  const installed = getInstalledModelsForEngine(systemInfo);
  const downloading = systemInfo.downloadingModels || [];
  const recommendedId = getRecommendedCategory(systemInfo.totalMemoryGB ?? 8);
  const recommendedCategory = modelCategories.find(
    (c) => c.id === recommendedId,
  );
  const recommendedModel = recommendedCategory?.models.find(
    (m) => !m.isQuantized && !m.isEnglishOnly,
  );
  const configuredProviders = providers.filter(isProviderConfigured);
  const gpuModeKey = (GPU_MODE_KEYS as readonly string[]).includes(
    gpuState?.gpuMode ?? '',
  )
    ? (gpuState?.gpuMode as string)
    : 'auto';
  const transcriptionEngine = systemInfo.transcriptionEngine ?? 'builtin';
  // ggml 推荐模型/一键下载仅适用于 whisper.cpp(builtin)；其它引擎在「模型」页有各自下载入口
  const isBuiltin = transcriptionEngine === 'builtin';
  const engineLabelKey =
    ENGINE_LABEL_KEYS[transcriptionEngine] ?? ENGINE_LABEL_KEYS.builtin;
  const showEngineWarning =
    transcriptionEngine === 'fasterWhisper' &&
    systemInfo.pythonEngineStatus?.state !== 'ready';

  // 「能否开始转写」只取决于引擎就绪 + 当前引擎已有模型；翻译服务为可选项，不计入就绪判断
  const modelsReady = hasModelsForEngine(systemInfo);
  const engineReady = !showEngineWarning;
  const allReady = modelsReady && engineReady;

  const renderReadinessBanner = () => {
    if (allReady) {
      return (
        <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/5 p-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t('overview.readyTitle')}</p>
            <p className="text-sm text-muted-foreground">
              {t('overview.readyDesc')}
            </p>
          </div>
        </div>
      );
    }
    const next = !engineReady
      ? { label: t('overview.nextInstallEngine'), tab: 'engines' }
      : { label: t('overview.nextDownloadModels'), tab: 'models' };
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t('overview.setupTitle')}</p>
            <p className="text-sm text-muted-foreground">
              {t('overview.setupDesc')}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={() => onNavigateTab(next.tab)}
        >
          {next.label}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    );
  };

  const renderGpuStatus = () => {
    if (!gpuState) return null;
    switch (gpuState.overviewKind) {
      case 'darwin':
        return (
          <p className="text-sm font-medium text-success">
            {t('overview.appleAcceleration')}
          </p>
        );
      case 'cpuManual':
        return (
          <p className="text-sm text-muted-foreground">
            {t('overview.gpuCpuManual')}
          </p>
        );
      case 'gpuOnlyOnCpu':
        return (
          <p className="text-sm font-medium text-warning">
            {t('overview.gpuOnlyOnCpu')}
          </p>
        );
      case 'gpuOnlyPending':
        return (
          <p className="text-sm font-medium text-muted-foreground">
            {t('overview.gpuGpuOnlyPending')}
          </p>
        );
      case 'autoPending':
        return (
          <p className="text-sm text-muted-foreground">
            {t('overview.gpuAutoPending')}
          </p>
        );
      case 'cpuFallback':
        return (
          <p className="text-sm font-medium text-warning">
            {t('overview.gpuCpuFallback')}
          </p>
        );
      case 'running':
        return (
          <p className="text-sm font-medium text-success">
            {t('overview.gpuRunning', {
              backend: gpuState.accelerationLabel,
            })}
          </p>
        );
      default:
        return null;
    }
  };

  const manageButton = (tab: string) => (
    <Button
      variant="ghost"
      size="sm"
      className="text-xs"
      onClick={(e) => {
        e.stopPropagation();
        onNavigateTab(tab);
      }}
    >
      {t('overview.manage')} <ArrowRight className="ml-1 h-3 w-3" />
    </Button>
  );

  const cardNavProps = (tab: keyof typeof OVERVIEW_CARD_DECOR) => ({
    role: 'button' as const,
    tabIndex: 0,
    className: cn(
      'group relative overflow-hidden flex flex-col cursor-pointer rounded-xl transition-all hover:shadow-md hover:-translate-y-0.5',
    ),
    onClick: () => onNavigateTab(tab),
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onNavigateTab(tab);
      }
    },
  });

  const cardDecor = (tab: keyof typeof OVERVIEW_CARD_DECOR) => (
    <CardDecor
      className={cn(
        'pointer-events-none absolute right-0 top-0 h-24 w-24 transition-transform duration-300 group-hover:scale-110',
        OVERVIEW_CARD_DECOR[tab],
      )}
    />
  );

  return (
    <div className="space-y-4">
      {renderReadinessBanner()}
      <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* 转写引擎 */}
        <Card {...cardNavProps('engines')}>
          {cardDecor('engines')}
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <IconChip icon={Cpu} />
              {t('overview.engineTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            <p className="text-sm font-medium">{t(engineLabelKey)}</p>
            {showEngineWarning && (
              <p className="flex items-start gap-1.5 text-sm text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                {t('overview.engineNotInstalled')}
              </p>
            )}
            <div className="mt-auto flex items-center gap-2 pt-1">
              {manageButton('engines')}
            </div>
          </CardContent>
        </Card>

        {/* 语音模型 */}
        <Card {...cardNavProps('models')}>
          {cardDecor('models')}
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <IconChip icon={Bot} />
              {t('overview.modelsTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            {installed.length > 0 ? (
              <>
                <p className="text-sm font-medium">
                  {t('overview.installedCount', { count: installed.length })}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {installed.slice(0, 3).join(' · ')}
                  {installed.length > 3 ? ' …' : ''}
                </p>
              </>
            ) : (
              <p className="flex items-start gap-1.5 text-sm text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                {t('overview.noModels')}
              </p>
            )}
            {downloading.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('overview.downloadingCount', { count: downloading.length })}
              </p>
            )}
            {isBuiltin && systemInfo.totalMemoryGB && recommendedModel ? (
              <p className="text-xs text-muted-foreground">
                {t('overview.recommendedModel', {
                  model: recommendedModel.name,
                  memory: systemInfo.totalMemoryGB,
                })}
              </p>
            ) : null}
            <div className="mt-auto flex items-center gap-2 pt-1">
              {isBuiltin && installed.length === 0 && recommendedModel && (
                <div onClick={(e) => e.stopPropagation()}>
                  <DownModel
                    modelName={recommendedModel.name}
                    callBack={refresh}
                    downSource={downSource}
                    needsCoreML={recommendedModel.needsCoreML}
                    globalDownloading={downloading.length > 0}
                  >
                    <DownModelButton />
                  </DownModel>
                </div>
              )}
              {manageButton('models')}
            </div>
          </CardContent>
        </Card>

        {/* 翻译服务 */}
        <Card {...cardNavProps('providers')}>
          {cardDecor('providers')}
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <IconChip icon={Languages} />
              {t('overview.providersTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            {configuredProviders.length > 0 ? (
              <>
                <p className="text-sm font-medium">
                  {t('overview.configuredCount', {
                    count: configuredProviders.length,
                  })}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {configuredProviders
                    .slice(0, 3)
                    .map((p) =>
                      commonT(`provider.${p.name}`, { defaultValue: p.name }),
                    )
                    .join(' · ')}
                  {configuredProviders.length > 3 ? ' …' : ''}
                </p>
              </>
            ) : (
              <p className="flex items-start gap-1.5 text-sm text-warning">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                {t('overview.noProviders')}
              </p>
            )}
            <div className="mt-auto flex items-center gap-2 pt-1">
              {configuredProviders.length === 0 && (
                <Button
                  size="sm"
                  className="text-xs gap-1.5"
                  onClick={() => onNavigateTab('providers')}
                >
                  <Plus className="h-4 w-4" />
                  {t('overview.enableProviders')}
                </Button>
              )}
              {manageButton('providers')}
            </div>
          </CardContent>
        </Card>

        {/* GPU 加速 */}
        <Card {...cardNavProps('acceleration')}>
          {cardDecor('acceleration')}
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <IconChip icon={Zap} />
              {t('overview.accelerationTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            {renderGpuStatus()}
            {gpuState && !gpuState.isDarwin && gpuState.gpuName && (
              <p className="text-xs text-muted-foreground truncate">
                {gpuState.gpuName}
              </p>
            )}
            {gpuState && !gpuState.isDarwin && (
              <p className="text-xs text-muted-foreground">
                {t('overview.gpuModeLabel', {
                  mode: t(`overview.gpuMode.${gpuModeKey}`),
                })}
              </p>
            )}
            {gpuState?.canUpgradeCuda && gpuState.recommendedCudaVersion && (
              <p className="flex items-start gap-1 text-xs text-muted-foreground">
                <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('overview.cudaUpgradeHint', {
                  version: gpuState.recommendedCudaVersion,
                })}
              </p>
            )}
            <div className="mt-auto flex items-center gap-2 pt-1">
              {manageButton('acceleration')}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default OverviewTab;

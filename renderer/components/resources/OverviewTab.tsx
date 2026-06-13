import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Bot, Languages, Zap, ArrowRight, AlertTriangle } from 'lucide-react';
import DownModel from '@/components/DownModel';
import DownModelButton from '@/components/DownModelButton';
import { modelCategories, getRecommendedCategory } from 'lib/utils';
import useLocalStorageState from 'hooks/useLocalStorageState';
import { isProviderConfigured } from 'lib/providerUtils';
import { ISystemInfo } from '../../../types/types';
import { Provider } from '../../../types';
import { DownSource } from './ModelsTab';

const GPU_MODE_KEYS = ['auto', 'cpu-only', 'custom'] as const;

type GpuStatus = {
  isDarwin: boolean;
  enabled: boolean;
  label: string;
  mode: string;
};

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
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
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
      const backendLabels: Record<string, string> = {
        cuda: 'CUDA',
        vulkan: 'Vulkan',
        cpu: 'CPU',
        metal: 'Metal',
        coreml: 'CoreML',
        custom: 'Custom',
      };
      const isDarwin = env?.platform === 'darwin';
      const isCpuResult = active?.backend === 'cpu';
      setGpu({
        isDarwin,
        enabled: isDarwin || (settings?.gpuMode !== 'cpu-only' && !isCpuResult),
        label:
          active && !isCpuResult
            ? active.backend === 'cuda' && active.variant
              ? `CUDA ${active.variant}`
              : backendLabels[active.backend] || active.backend
            : '',
        mode: settings?.gpuMode || 'auto',
      });
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

  const installed = systemInfo.modelsInstalled || [];
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
    gpu?.mode ?? '',
  )
    ? (gpu?.mode as string)
    : 'auto';

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

  // 整卡可点：点击 / Enter / Space 跳转到对应 tab
  const cardNavProps = (tab: string) => ({
    role: 'button' as const,
    tabIndex: 0,
    className: 'flex flex-col cursor-pointer transition-shadow hover:shadow-md',
    onClick: () => onNavigateTab(tab),
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onNavigateTab(tab);
      }
    },
  });

  return (
    <div className="grid items-stretch gap-4 md:grid-cols-3">
      {/* 语音模型 */}
      <Card {...cardNavProps('models')}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4" />
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
          {systemInfo.totalMemoryGB && recommendedModel ? (
            <p className="text-xs text-muted-foreground">
              {t('overview.recommendedModel', {
                model: recommendedModel.name,
                memory: systemInfo.totalMemoryGB,
              })}
            </p>
          ) : null}
          <div className="mt-auto flex items-center gap-2 pt-1">
            {installed.length === 0 && recommendedModel && (
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
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Languages className="h-4 w-4" />
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
                className="text-xs"
                onClick={() => onNavigateTab('providers')}
              >
                {t('overview.enableProviders')}
              </Button>
            )}
            {manageButton('providers')}
          </div>
        </CardContent>
      </Card>

      {/* GPU 加速 */}
      <Card {...cardNavProps('acceleration')}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4" />
            {t('overview.accelerationTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3">
          {gpu?.isDarwin ? (
            <p className="text-sm font-medium text-success">
              {t('overview.appleAcceleration')}
            </p>
          ) : gpu?.enabled && gpu.label ? (
            <p className="text-sm font-medium text-success">
              {t('overview.gpuRunning', { backend: gpu.label })}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('overview.gpuNotEnabled')}
            </p>
          )}
          {gpu && !gpu.isDarwin && (
            <p className="text-xs text-muted-foreground">
              {t('overview.gpuModeLabel', {
                mode: t(`overview.gpuMode.${gpuModeKey}`),
              })}
            </p>
          )}
          <div className="mt-auto flex items-center gap-2 pt-1">
            {manageButton('acceleration')}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default OverviewTab;

import React, { useEffect, useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  modelCategories,
  getRecommendedCategory,
  getModelDownloadUrl,
  type ModelInfo,
  cn,
} from 'lib/utils';
import {
  DownSource,
  matchesModelQuery,
  MODELS_INSTALLED_ONLY_KEY,
  MODELS_TIER_VARIANTS_EXPANDED_KEY,
} from 'lib/modelPanelUtils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { ISystemInfo } from '../../../types/types';
import DeleteModel from '@/components/DeleteModel';
import DownModel from '@/components/DownModel';
import DownModelButton from '@/components/DownModelButton';
import {
  Upload,
  Copy,
  ChevronDown,
  ChevronUp,
  Star,
  Zap,
  Target,
  HardDrive,
  CheckCircle2,
  HelpCircle,
  FolderOpen,
  Download,
  Rocket,
  Scale,
  Crosshair,
  Trash2,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import useLocalStorageState from 'hooks/useLocalStorageState';

export { DownSource } from 'lib/modelPanelUtils';

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

const MODEL_TIERS = [
  { id: 'fast', icon: Rocket, categoryIds: ['tiny', 'base'] },
  { id: 'balanced', icon: Scale, categoryIds: ['small', 'medium'] },
  { id: 'accurate', icon: Crosshair, categoryIds: ['largeTurbo', 'large'] },
] as const;

function RatingDots({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-2 w-2 rounded-full',
            i < value ? 'bg-primary' : 'bg-muted',
          )}
        />
      ))}
    </span>
  );
}

function HeroDownloadButton({
  loading,
  progress,
  detail,
  handleDownModel,
  disabled,
  label,
}: {
  loading?: boolean;
  progress?: number;
  detail?: any;
  handleDownModel?: () => void;
  disabled?: boolean;
  label: string;
}) {
  if (loading) {
    return (
      <DownModelButton
        loading={loading}
        progress={progress}
        detail={detail}
        handleDownModel={handleDownModel}
        disabled={disabled}
      />
    );
  }
  return (
    <Button onClick={handleDownModel} disabled={disabled} size="sm">
      <Download className="mr-1.5 h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

function RecommendedHero({
  model,
  isInstalled,
  basis,
  basisLoading,
  downSource,
  onUpdate,
  globalDownloading,
  t,
}: {
  model: ModelInfo;
  isInstalled: boolean;
  basis: string | null;
  basisLoading: boolean;
  downSource: DownSource;
  onUpdate: () => void;
  globalDownloading: boolean;
  t: TFunc;
}) {
  const desc = t(`modelDesc.${model.name}`, { defaultValue: '' });
  return (
    <div className="rounded-xl border border-primary/30 bg-gradient-to-r from-primary/5 to-transparent p-4 flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-start gap-3 min-w-0">
        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Star className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {t('recommendedHero', { model: model.name })}
          </div>
          {desc && (
            <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
          )}
          {basisLoading ? (
            <div className="text-[11px] text-muted-foreground/70 mt-0.5 animate-pulse">
              {t('detectingHardware')}
            </div>
          ) : (
            basis && (
              <div className="text-[11px] text-muted-foreground/70 mt-0.5">
                {basis}
              </div>
            )
          )}
        </div>
      </div>
      <div className="flex-shrink-0">
        {isInstalled ? (
          <Badge
            variant="outline"
            className="border-success/40 text-success gap-1"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t('alreadyInstalled')}
          </Badge>
        ) : (
          <DownModel
            modelName={model.name}
            callBack={onUpdate}
            downSource={downSource}
            needsCoreML={model.needsCoreML}
            globalDownloading={globalDownloading}
          >
            <HeroDownloadButton
              label={t('oneClickDownload', { size: model.size })}
            />
          </DownModel>
        )}
      </div>
    </div>
  );
}

function ModelRowActions({
  model,
  isInstalled,
  isDownloading,
  downSource,
  onUpdate,
  t,
  globalDownloading,
  copyToClipboard,
}: {
  model: ModelInfo;
  isInstalled: boolean;
  isDownloading: boolean;
  downSource: DownSource;
  onUpdate: () => void;
  t: TFunc;
  globalDownloading: boolean;
  copyToClipboard: (text: string) => void;
}) {
  const downloadUrl = getModelDownloadUrl(model.name, downSource);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => copyToClipboard(downloadUrl)}
            aria-label={t('copyLink')}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('copyLink')}</p>
        </TooltipContent>
      </Tooltip>
      {isInstalled && !isDownloading ? (
        <DeleteModel modelName={model.name} callBack={onUpdate}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground hover:text-destructive gap-1.5"
          >
            <Trash2 className="h-4 w-4" />
            <span className="sr-only sm:not-sr-only sm:inline">
              {t('delete')}
            </span>
          </Button>
        </DeleteModel>
      ) : (
        <DownModel
          modelName={model.name}
          callBack={onUpdate}
          downSource={downSource}
          needsCoreML={model.needsCoreML}
          globalDownloading={globalDownloading}
        >
          <DownModelButton />
        </DownModel>
      )}
    </>
  );
}

function ModelRow({
  model,
  desc,
  speed,
  quality,
  isRecommended,
  isInstalled,
  isDownloading,
  downSource,
  onUpdate,
  t,
  globalDownloading,
}: {
  model: ModelInfo;
  desc?: string;
  speed?: number;
  quality?: number;
  isRecommended?: boolean;
  isInstalled: boolean;
  isDownloading: boolean;
  downSource: DownSource;
  onUpdate: () => void;
  t: TFunc;
  globalDownloading: boolean;
}) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t('copySuccess'), { duration: 2000 }))
      .catch(() => toast.error(t('copyError'), { duration: 2000 }));
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-2 py-2 px-3 rounded-lg transition-colors sm:flex-row sm:items-center sm:gap-3',
        isRecommended
          ? 'border border-primary/30 bg-primary/5'
          : 'hover:bg-muted/50',
      )}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="font-mono text-sm font-medium flex-shrink-0">
          {model.name}
        </span>
        {isRecommended && (
          <Badge className="text-[10px] px-1.5 py-0 flex-shrink-0">
            <Star className="h-3 w-3 mr-0.5" />
            {t('recommended')}
          </Badge>
        )}
        {model.isQuantized && (
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 flex-shrink-0"
          >
            {t('quantizedLabel')}
          </Badge>
        )}
        {model.isEnglishOnly && (
          <Badge
            variant="secondary"
            className="text-[10px] px-1.5 py-0 flex-shrink-0"
          >
            {t('englishOnly')}
          </Badge>
        )}
        {isInstalled && !isDownloading && (
          <CheckCircle2 className="h-3.5 w-3.5 text-success flex-shrink-0" />
        )}
        {desc && (
          <span className="text-xs text-muted-foreground truncate hidden md:inline">
            {desc}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 sm:justify-end sm:gap-3 flex-shrink-0">
        <div className="flex items-center gap-2 sm:gap-3">
          {speed != null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="hidden lg:inline-flex items-center gap-1 text-muted-foreground">
                  <Zap className="h-3 w-3" />
                  <RatingDots value={speed} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('speedRatingTip')}</p>
              </TooltipContent>
            </Tooltip>
          )}
          {quality != null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="hidden lg:inline-flex items-center gap-1 text-muted-foreground">
                  <Target className="h-3 w-3" />
                  <RatingDots value={quality} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('qualityRatingTip')}</p>
              </TooltipContent>
            </Tooltip>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {model.size}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <ModelRowActions
            model={model}
            isInstalled={isInstalled}
            isDownloading={isDownloading}
            downSource={downSource}
            onUpdate={onUpdate}
            t={t}
            globalDownloading={globalDownloading}
            copyToClipboard={copyToClipboard}
          />
        </div>
      </div>
    </div>
  );
}

function TierSection({
  tier,
  recommendedModelName,
  installedOnly,
  modelQuery,
  variantsExpanded,
  onVariantsExpandedChange,
  systemInfo,
  downSource,
  onUpdate,
  t,
  globalDownloading,
}: {
  tier: (typeof MODEL_TIERS)[number];
  recommendedModelName?: string;
  installedOnly: boolean;
  modelQuery: string;
  variantsExpanded: boolean;
  onVariantsExpandedChange: (expanded: boolean) => void;
  systemInfo: ISystemInfo;
  downSource: DownSource;
  onUpdate: () => void;
  t: TFunc;
  globalDownloading: boolean;
}) {
  const categories = tier.categoryIds
    .map((id) => modelCategories.find((c) => c.id === id))
    .filter(Boolean);

  const isInstalled = (name: string) =>
    systemInfo?.modelsInstalled?.includes(name.toLowerCase());
  const isDownloading = (name: string) =>
    systemInfo?.downloadingModels?.includes(name);

  const primaryRows = categories.flatMap((cat) =>
    cat.models
      .filter((m) => !m.isQuantized && !m.isEnglishOnly)
      .map((m) => ({ model: m, speed: cat.speed, quality: cat.quality })),
  );
  const variantRows = categories.flatMap((cat) =>
    cat.models.filter((m) => m.isQuantized || m.isEnglishOnly),
  );

  const visiblePrimary = primaryRows
    .filter((r) => !installedOnly || isInstalled(r.model.name))
    .filter((r) => matchesModelQuery(r.model.name, modelQuery));
  const visibleVariants = variantRows
    .filter((m) => !installedOnly || isInstalled(m.name))
    .filter((m) => matchesModelQuery(m.name, modelQuery));

  if (visiblePrimary.length === 0 && visibleVariants.length === 0) {
    return null;
  }

  const minRAM = Math.min(...categories.map((c) => c.minRAM));
  const showVariants = variantsExpanded || installedOnly || !!modelQuery.trim();

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 px-1 flex-wrap">
        <tier.icon className="h-4 w-4 text-muted-foreground self-center" />
        <h3 className="text-sm font-semibold">{t(`tier.${tier.id}`)}</h3>
        <span className="text-xs text-muted-foreground">
          {t(`tierDesc.${tier.id}`)} · {t('tierRAM', { ram: minRAM })}
        </span>
      </div>
      <Card>
        <CardContent className="p-2 space-y-0.5">
          {visiblePrimary.map(({ model, speed, quality }) => (
            <ModelRow
              key={model.name}
              model={model}
              desc={t(`modelDesc.${model.name}`, { defaultValue: '' })}
              speed={speed}
              quality={quality}
              isRecommended={model.name === recommendedModelName}
              isInstalled={isInstalled(model.name)}
              isDownloading={isDownloading(model.name)}
              downSource={downSource}
              onUpdate={onUpdate}
              t={t}
              globalDownloading={globalDownloading}
            />
          ))}

          {visibleVariants.length > 0 && (
            <div className="pt-1">
              {!installedOnly && !modelQuery.trim() && (
                <button
                  type="button"
                  onClick={() => onVariantsExpandedChange(!variantsExpanded)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 px-3"
                >
                  {variantsExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {variantsExpanded
                    ? t('hideVariants')
                    : `${t('showAllVariants')} (${visibleVariants.length})`}
                </button>
              )}

              {showVariants && (
                <div className="space-y-0.5 mt-1">
                  {!installedOnly && !modelQuery.trim() && (
                    <div className="flex items-center gap-1 px-3 pb-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <HelpCircle className="h-3 w-3 text-muted-foreground" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="max-w-[250px]">{t('quantizedTip')}</p>
                        </TooltipContent>
                      </Tooltip>
                      <span className="text-[10px] text-muted-foreground">
                        {t('quantizedTip')}
                      </span>
                    </div>
                  )}
                  {visibleVariants.map((model) => (
                    <ModelRow
                      key={model.name}
                      model={model}
                      isInstalled={isInstalled(model.name)}
                      isDownloading={isDownloading(model.name)}
                      downSource={downSource}
                      onUpdate={onUpdate}
                      t={t}
                      globalDownloading={globalDownloading}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

const ModelsTab = () => {
  const { t } = useTranslation('modelsControl');
  const [systemInfo, setSystemInfo] = useState<ISystemInfo>({
    modelsInstalled: [],
    downloadingModels: [],
    modelsPath: '',
  });
  const [systemInfoLoaded, setSystemInfoLoaded] = useState(false);
  const [globalDownloading, setGlobalDownloading] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [accelAvailable, setAccelAvailable] = useState(false);
  const [installedOnly, setInstalledOnly] = useLocalStorageState<boolean>(
    MODELS_INSTALLED_ONLY_KEY,
    false,
    (v) => typeof v === 'boolean',
  );
  const [variantsExpandedMap, setVariantsExpandedMap] = useLocalStorageState<
    Record<string, boolean>
  >(
    MODELS_TIER_VARIANTS_EXPANDED_KEY,
    {},
    (v) => v !== null && typeof v === 'object',
  );
  const [downSource, setDownSource] = useLocalStorageState<DownSource>(
    'downSource',
    DownSource.HuggingFace,
    (val) => Object.values(DownSource).includes(val as DownSource),
  );

  const updateSystemInfo = useCallback(async () => {
    try {
      const systemInfoRes = await window?.ipc?.invoke('getSystemInfo', null);
      if (systemInfoRes) setSystemInfo(systemInfoRes);
    } catch (error) {
      console.error('Failed to load system info:', error);
      toast.error(t('loadSystemInfoFailed'));
    } finally {
      setSystemInfoLoaded(true);
    }
  }, [t]);

  useEffect(() => {
    updateSystemInfo();

    (async () => {
      try {
        const env = await window?.ipc?.invoke('get-gpu-environment');
        const active = await window?.ipc?.invoke('get-active-backend');
        const isDarwin = env?.platform === 'darwin';
        setAccelAvailable(
          isDarwin || (!!active?.backend && active.backend !== 'cpu'),
        );
      } catch (error) {
        console.error('Failed to detect acceleration:', error);
      }
    })();

    const unsubProgress = window?.ipc?.on(
      'downloadProgress',
      (_model: string, progressValue: number) => {
        setGlobalDownloading(progressValue >= 0 && progressValue < 1);
        if (progressValue >= 1) {
          void updateSystemInfo();
        }
      },
    );

    return () => {
      unsubProgress?.();
    };
  }, [updateSystemInfo]);

  const handleDownSource = (value: string) => {
    setDownSource(value as DownSource);
  };

  const handleImportModel = async () => {
    try {
      const result = await window?.ipc?.invoke('importModel');
      if (result?.success) {
        toast.success(t('importModelSuccess'), { duration: 2000 });
        updateSystemInfo();
        return;
      }
      if (result?.canceled) return;
      toast.error(
        t('importModelFailed', {
          error: result?.error || t('unknownError'),
        }),
      );
    } catch (error) {
      console.error('Failed to import model:', error);
      toast.error(
        t('importModelFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const handleChangeModelsPath = async () => {
    const result = await window?.ipc?.invoke('selectDirectory');
    if (result.canceled) return;

    try {
      await window?.ipc?.invoke('setSettings', {
        modelsPath: result.directoryPath,
      });
      toast.success(t('modelPathChanged'), { duration: 2000 });
      updateSystemInfo();
    } catch (error) {
      console.error('Failed to change models path:', error);
      toast.error(
        t('changePathFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const handleOpenModelsFolder = async () => {
    try {
      const result = await window?.ipc?.invoke('openModelsFolder');
      if (!result?.success) {
        toast.error(
          t('openFolderFailed', {
            error: result?.error || t('unknownError'),
          }),
        );
      }
    } catch (error) {
      console.error('Failed to open models folder:', error);
      toast.error(
        t('openFolderFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const setTierVariantsExpanded = (tierId: string, expanded: boolean) => {
    setVariantsExpandedMap((prev) => ({ ...prev, [tierId]: expanded }));
  };

  const recommendedId = getRecommendedCategory(systemInfo.totalMemoryGB ?? 8);
  const recommendedCategory = modelCategories.find(
    (c) => c.id === recommendedId,
  );
  const recommendedModel = recommendedCategory?.models.find(
    (m) => !m.isQuantized && !m.isEnglishOnly,
  );
  const recommendedInstalled = recommendedModel
    ? systemInfo?.modelsInstalled?.includes(recommendedModel.name.toLowerCase())
    : false;
  const basis =
    systemInfoLoaded && systemInfo.totalMemoryGB
      ? t(accelAvailable ? 'recommendedBasisWithGpu' : 'recommendedBasis', {
          memory: systemInfo.totalMemoryGB,
        })
      : null;

  const hasAnyInstalled = (systemInfo?.modelsInstalled?.length ?? 0) > 0;
  const trimmedQuery = modelQuery.trim();
  const isModelVisible = (name: string) => {
    if (
      installedOnly &&
      !systemInfo.modelsInstalled?.includes(name.toLowerCase())
    ) {
      return false;
    }
    return matchesModelQuery(name, modelQuery);
  };
  const hasVisibleModels = modelCategories.some((cat) =>
    cat.models.some((m) => isModelVisible(m.name)),
  );
  const showRecommendedHero = !!recommendedModel;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-4">
        {showRecommendedHero && (
          <RecommendedHero
            model={recommendedModel}
            isInstalled={recommendedInstalled}
            basis={basis}
            basisLoading={!systemInfoLoaded}
            downSource={downSource}
            onUpdate={updateSystemInfo}
            globalDownloading={globalDownloading}
            t={t}
          />
        )}

        <div className="sticky top-0 z-10 space-y-3 border-b bg-background/95 pb-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{t('modelManagement')}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {t('modelManagementDesc')}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
                <Switch
                  checked={installedOnly}
                  onCheckedChange={setInstalledOnly}
                />
                {t('showInstalledOnly')}
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground shrink-0">
                  {t('switchDownloadSource')}:
                </span>
                <Select onValueChange={handleDownSource} value={downSource}>
                  <SelectTrigger className="w-full sm:w-[200px] h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="huggingface">
                      {t('officialSource')}
                    </SelectItem>
                    <SelectItem value="hf-mirror">
                      {t('domesticMirror')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleImportModel}
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {t('importModel')}
              </Button>
            </div>
          </div>

          <div className="relative px-0.5">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder={t('modelSearchPlaceholder')}
              className="h-8 pl-8 text-sm focus-visible:ring-offset-0 focus-visible:ring-inset"
            />
          </div>
        </div>

        <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1 gap-y-1">
          <HardDrive className="h-3 w-3 shrink-0" />
          <span className="shrink-0">{t('modelPath')}:</span>
          <span className="font-mono break-all">{systemInfo?.modelsPath}</span>
          <button
            type="button"
            onClick={handleOpenModelsFolder}
            className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 transition-colors"
          >
            <FolderOpen className="h-3 w-3" />
            <span>{t('openModelsFolder')}</span>
          </button>
          <span className="text-muted-foreground/50">·</span>
          <button
            type="button"
            onClick={handleChangeModelsPath}
            className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 transition-colors"
          >
            <span>{t('changePath')}</span>
          </button>
        </div>

        {installedOnly && !hasAnyInstalled ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {t('noInstalledModels')}
          </p>
        ) : trimmedQuery && !hasVisibleModels ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            {t('noModelMatch')}
          </p>
        ) : (
          <div className="space-y-5">
            {MODEL_TIERS.map((tier) => (
              <TierSection
                key={tier.id}
                tier={tier}
                recommendedModelName={recommendedModel?.name}
                installedOnly={installedOnly}
                modelQuery={modelQuery}
                variantsExpanded={variantsExpandedMap[tier.id] ?? false}
                onVariantsExpandedChange={(expanded) =>
                  setTierVariantsExpanded(tier.id, expanded)
                }
                systemInfo={systemInfo}
                downSource={downSource}
                onUpdate={updateSystemInfo}
                t={t}
                globalDownloading={globalDownloading}
              />
            ))}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
};

export default ModelsTab;

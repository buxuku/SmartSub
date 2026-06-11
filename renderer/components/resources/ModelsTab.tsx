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
} from 'lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
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
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import useLocalStorageState from 'hooks/useLocalStorageState';

export enum DownSource {
  HuggingFace = 'huggingface',
  HfMirror = 'hf-mirror',
}

type TFunc = (key: string, opts?: any) => string;

const MODEL_TIERS = [
  { id: 'fast', emoji: '🚀', categoryIds: ['tiny', 'base'] },
  { id: 'balanced', emoji: '⚖️', categoryIds: ['small', 'medium'] },
  { id: 'accurate', emoji: '🎯', categoryIds: ['largeTurbo', 'large'] },
] as const;

function RatingDots({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={`h-2 w-2 rounded-full ${
            i < value ? 'bg-primary' : 'bg-muted'
          }`}
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
  downSource,
  onUpdate,
  globalDownloading,
  t,
}: {
  model: ModelInfo;
  isInstalled: boolean;
  basis: string | null;
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
          {basis && (
            <div className="text-[11px] text-muted-foreground/70 mt-0.5">
              {basis}
            </div>
          )}
        </div>
      </div>
      <div className="flex-shrink-0">
        {isInstalled ? (
          <Badge
            variant="outline"
            className="border-green-500/40 text-green-600 dark:text-green-400 gap-1"
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
      className={`flex items-center gap-3 py-2 px-3 rounded-lg transition-colors ${
        isRecommended
          ? 'border border-primary/30 bg-primary/5'
          : 'hover:bg-muted/50'
      }`}
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
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
        )}
        {desc && (
          <span className="text-xs text-muted-foreground truncate">{desc}</span>
        )}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {speed != null && (
          <span className="hidden lg:inline-flex items-center gap-1 text-muted-foreground">
            <Zap className="h-3 w-3" />
            <RatingDots value={speed} />
          </span>
        )}
        {quality != null && (
          <span className="hidden lg:inline-flex items-center gap-1 text-muted-foreground">
            <Target className="h-3 w-3" />
            <RatingDots value={quality} />
          </span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums w-[60px] text-right">
          {model.size}
        </span>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Copy
                className="h-3.5 w-3.5 cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
                onClick={() =>
                  copyToClipboard(getModelDownloadUrl(model.name, downSource))
                }
              />
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('copyLink')}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {isInstalled && !isDownloading ? (
          <DeleteModel modelName={model.name} callBack={onUpdate}>
            <Button variant="destructive" size="sm" className="h-7 text-xs">
              {t('delete')}
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
      </div>
    </div>
  );
}

function TierSection({
  tier,
  recommendedModelName,
  installedOnly,
  systemInfo,
  downSource,
  onUpdate,
  t,
  globalDownloading,
}: {
  tier: (typeof MODEL_TIERS)[number];
  recommendedModelName?: string;
  installedOnly: boolean;
  systemInfo: ISystemInfo;
  downSource: DownSource;
  onUpdate: () => void;
  t: TFunc;
  globalDownloading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

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

  const visiblePrimary = installedOnly
    ? primaryRows.filter((r) => isInstalled(r.model.name))
    : primaryRows;
  const visibleVariants = installedOnly
    ? variantRows.filter((m) => isInstalled(m.name))
    : variantRows;

  if (visiblePrimary.length === 0 && visibleVariants.length === 0) {
    return null;
  }

  const minRAM = Math.min(...categories.map((c) => c.minRAM));

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 px-1 flex-wrap">
        <span className="text-sm">{tier.emoji}</span>
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
              {!installedOnly && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 px-3"
                >
                  {expanded ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {expanded
                    ? t('hideVariants')
                    : `${t('showAllVariants')} (${visibleVariants.length})`}
                </button>
              )}

              {(expanded || installedOnly) && (
                <div className="space-y-0.5 mt-1">
                  {!installedOnly && (
                    <div className="flex items-center gap-1 px-3 pb-1">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <HelpCircle className="h-3 w-3 text-muted-foreground" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="max-w-[250px]">{t('quantizedTip')}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
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
  const [globalDownloading, setGlobalDownloading] = useState(false);
  const [installedOnly, setInstalledOnly] = useState(false);
  const [accelAvailable, setAccelAvailable] = useState(false);
  const [downSource, setDownSource] = useLocalStorageState<DownSource>(
    'downSource',
    DownSource.HuggingFace,
    (val) => Object.values(DownSource).includes(val as DownSource),
  );

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
        setGlobalDownloading(0.0 <= progressValue && progressValue < 1.0);
      },
    );

    return () => {
      unsubProgress?.();
    };
  }, []);

  const updateSystemInfo = useCallback(async () => {
    const systemInfoRes = await window?.ipc?.invoke('getSystemInfo', null);
    setSystemInfo(systemInfoRes);
  }, []);

  const handleDownSource = (value: string) => {
    setDownSource(value as DownSource);
  };

  const handleImportModel = async () => {
    try {
      const result = await window?.ipc?.invoke('importModel');
      if (result) {
        toast.success(t('importModelSuccess'), { duration: 2000 });
        updateSystemInfo();
      }
    } catch (error) {
      console.error('Failed to import model:', error);
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
    }
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
  const basis = systemInfo.totalMemoryGB
    ? t(accelAvailable ? 'recommendedBasisWithGpu' : 'recommendedBasis', {
        memory: systemInfo.totalMemoryGB,
      })
    : null;

  const hasAnyInstalled = (systemInfo?.modelsInstalled?.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">{t('modelManagement')}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t('modelManagementDesc')}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <Switch
              checked={installedOnly}
              onCheckedChange={setInstalledOnly}
            />
            {t('showInstalledOnly')}
          </label>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {t('switchDownloadSource')}:
            </span>
            <Select onValueChange={handleDownSource} value={downSource}>
              <SelectTrigger className="w-[200px] h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="huggingface">
                  {t('officialSource')}
                </SelectItem>
                <SelectItem value="hf-mirror">{t('domesticMirror')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleImportModel} size="sm" variant="outline">
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            {t('importModel')}
          </Button>
        </div>
      </div>

      {recommendedModel && (
        <RecommendedHero
          model={recommendedModel}
          isInstalled={recommendedInstalled}
          basis={basis}
          downSource={downSource}
          onUpdate={updateSystemInfo}
          globalDownloading={globalDownloading}
          t={t}
        />
      )}

      <div className="text-xs text-muted-foreground flex items-center gap-1">
        <HardDrive className="h-3 w-3" />
        {t('modelPath')}:{' '}
        <span className="font-mono">{systemInfo?.modelsPath}</span>
        <button
          onClick={handleChangeModelsPath}
          className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 transition-colors ml-1"
        >
          <FolderOpen className="h-3 w-3" />
          <span>{t('changePath')}</span>
        </button>
      </div>

      {installedOnly && !hasAnyInstalled ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {t('noInstalledModels')}
        </p>
      ) : (
        <div className="space-y-5">
          {MODEL_TIERS.map((tier) => (
            <TierSection
              key={tier.id}
              tier={tier}
              recommendedModelName={recommendedModel?.name}
              installedOnly={installedOnly}
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
  );
};

export default ModelsTab;

import React, { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DownloadSourceProvider,
  type DownloadSourceConfig,
} from '@/components/resources/engines/DownloadSourcePopover';
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
import DownModel, { type ModelDownloadFormat } from '@/components/DownModel';
import DownModelButton from '@/components/DownModelButton';
import useDownloadEndpoints from 'hooks/useDownloadEndpoints';
import {
  Upload,
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
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { importModelFromFolder } from 'lib/importModel';
import { useTranslation } from 'next-i18next';
import useLocalStorageState from 'hooks/useLocalStorageState';
import fasterWhisperModels from 'lib/fasterWhisperModels.json';
import type { TranscriptionEngine } from '../../../types/engine';
import FunasrModelSection from '@/components/resources/FunasrModelSection';
import QwenModelSection from '@/components/resources/QwenModelSection';
import FireRedModelSection from '@/components/resources/FireRedModelSection';

type FasterWhisperModelEntry = {
  id: string;
  hfRepo: string;
  size: string;
  tier: 'fast' | 'balanced' | 'accurate';
  speed: number;
  quality: number;
  englishOnly?: boolean;
  distil?: boolean;
};

function getCt2ProgressKey(modelId: string): string {
  return `ct2:${modelId}`;
}

function isCt2Downloading(
  modelId: string,
  downloadingModels?: string[],
): boolean {
  return downloadingModels?.includes(getCt2ProgressKey(modelId)) ?? false;
}

function isFasterWhisperModelInstalled(
  modelId: string,
  installed?: string[],
): boolean {
  if (!installed?.length) return false;
  const dotted = modelId.replace(/-/g, '.');
  return installed.includes(modelId) || installed.includes(dotted);
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

const MODEL_TIERS = [
  { id: 'fast', icon: Rocket, categoryIds: ['tiny', 'base'] },
  { id: 'balanced', icon: Scale, categoryIds: ['small', 'medium'] },
  { id: 'accurate', icon: Crosshair, categoryIds: ['largeTurbo', 'large'] },
] as const;

const CT2_TIERS = [
  { id: 'fast' as const, icon: Rocket },
  { id: 'balanced' as const, icon: Scale },
  { id: 'accurate' as const, icon: Crosshair },
];

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
  handleCancel,
  disabled,
  label,
}: {
  loading?: boolean;
  progress?: number;
  detail?: any;
  handleDownModel?: () => void;
  handleCancel?: () => void;
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
        handleCancel={handleCancel}
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
  modelName,
  modelSize,
  isInstalled,
  basis,
  basisLoading,
  downSource,
  onUpdate,
  globalDownloading,
  t,
  format = 'ggml',
  needsCoreML = true,
}: {
  modelName: string;
  modelSize: string;
  isInstalled: boolean;
  basis: string | null;
  basisLoading: boolean;
  downSource: DownSource;
  onUpdate: () => void;
  globalDownloading: boolean;
  t: TFunc;
  format?: ModelDownloadFormat;
  needsCoreML?: boolean;
}) {
  const desc = t(`modelDesc.${modelName}`, { defaultValue: '' });
  return (
    <div className="rounded-lg border border-primary/30 bg-gradient-to-r from-primary/5 to-transparent p-4 flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-start gap-3 min-w-0">
        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
          <Star className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {t('recommendedHero', { model: modelName })}
          </div>
          {desc && (
            <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
          )}
          {basisLoading ? (
            <div className="text-[11px] text-muted-foreground mt-0.5 animate-pulse">
              {t('detectingHardware')}
            </div>
          ) : (
            basis && (
              <div className="text-[11px] text-muted-foreground mt-0.5">
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
            modelName={modelName}
            callBack={onUpdate}
            downSource={downSource}
            needsCoreML={needsCoreML}
            globalDownloading={globalDownloading}
            format={format}
          >
            <HeroDownloadButton
              label={t('oneClickDownload', { size: modelSize })}
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
}: {
  model: ModelInfo;
  isInstalled: boolean;
  isDownloading: boolean;
  downSource: DownSource;
  onUpdate: () => void;
  t: TFunc;
  globalDownloading: boolean;
}) {
  const endpoints = useDownloadEndpoints();

  return (
    <>
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
          getCopyUrl={(s) =>
            getModelDownloadUrl(model.name, s as DownSource, endpoints)
          }
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
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
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
          />
        </div>
      </div>
    </div>
  );
}

function Ct2ModelRowActions({
  model,
  isInstalled,
  isDownloading,
  downSource,
  onUpdate,
  t,
  globalDownloading,
}: {
  model: FasterWhisperModelEntry;
  isInstalled: boolean;
  isDownloading: boolean;
  downSource: DownSource;
  onUpdate: () => void;
  t: TFunc;
  globalDownloading: boolean;
}) {
  const endpoints = useDownloadEndpoints();
  // base 已含协议（如 https://hf-mirror.com），与设置页配置保持一致。
  const ct2CopyUrl = (s: string) => {
    const base =
      s === DownSource.HuggingFace
        ? endpoints.huggingFaceOfficial
        : endpoints.huggingFaceMirror;
    return `${base}/${model.hfRepo}`;
  };

  const handleImportCt2 = async () => {
    const o = await importModelFromFolder('fasterWhisper', model.id);
    if (o.kind === 'success') {
      toast.success(t('importModelSuccess'), { duration: 2000 });
      onUpdate();
    } else if (o.kind === 'invalid-layout') {
      toast.error(t('importInvalidLayout', { files: o.missing.join(', ') }));
    } else if (o.kind === 'error') {
      toast.error(t('importModelFailed', { error: o.message }));
    }
  };

  return (
    <>
      {isInstalled && !isDownloading ? (
        <DeleteModel modelName={model.id} format="ct2" callBack={onUpdate}>
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
        <>
          <DownModel
            modelName={model.id}
            format="ct2"
            callBack={onUpdate}
            downSource={downSource}
            globalDownloading={globalDownloading}
            getCopyUrl={ct2CopyUrl}
          >
            <DownModelButton />
          </DownModel>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground gap-1.5"
            onClick={handleImportCt2}
          >
            <Upload className="h-4 w-4" />
            <span className="sr-only sm:not-sr-only sm:inline">
              {t('importFromFolder')}
            </span>
          </Button>
        </>
      )}
    </>
  );
}

function Ct2ModelRow({
  model,
  isInstalled,
  isDownloading,
  downSource,
  onUpdate,
  t,
  globalDownloading,
  isRecommended,
}: {
  model: FasterWhisperModelEntry;
  isInstalled: boolean;
  isDownloading: boolean;
  downSource: DownSource;
  onUpdate: () => void;
  t: TFunc;
  globalDownloading: boolean;
  isRecommended?: boolean;
}) {
  const desc = t(`modelDesc.${model.id}`, { defaultValue: '' });

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
          {model.id}
        </span>
        {isRecommended && (
          <Badge className="text-[10px] px-1.5 py-0 flex-shrink-0">
            <Star className="h-3 w-3 mr-0.5" />
            {t('recommended')}
          </Badge>
        )}
        {model.distil && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {t('distilLabel')}
          </Badge>
        )}
        {model.englishOnly && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="hidden lg:inline-flex items-center gap-1 text-muted-foreground">
                <Zap className="h-3 w-3" />
                <RatingDots value={model.speed} />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('speedRatingTip')}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="hidden lg:inline-flex items-center gap-1 text-muted-foreground">
                <Target className="h-3 w-3" />
                <RatingDots value={model.quality} />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('qualityRatingTip')}</p>
            </TooltipContent>
          </Tooltip>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {model.size}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Ct2ModelRowActions
            model={model}
            isInstalled={isInstalled}
            isDownloading={isDownloading}
            downSource={downSource}
            onUpdate={onUpdate}
            t={t}
            globalDownloading={globalDownloading}
          />
        </div>
      </div>
    </div>
  );
}

function FasterWhisperTierSection({
  tier,
  models,
  installedOnly,
  modelQuery,
  recommendedModelId,
  installed,
  downSource,
  onUpdate,
  t,
  globalDownloading,
  systemInfo,
}: {
  tier: (typeof CT2_TIERS)[number];
  models: FasterWhisperModelEntry[];
  installedOnly: boolean;
  modelQuery: string;
  recommendedModelId?: string;
  installed?: string[];
  downSource: DownSource;
  onUpdate: () => void;
  t: TFunc;
  globalDownloading: boolean;
  systemInfo: ISystemInfo;
}) {
  const visible = models
    .filter(
      (m) => !installedOnly || isFasterWhisperModelInstalled(m.id, installed),
    )
    .filter((m) =>
      matchesModelQuery(
        [m.id, t(`modelDesc.${m.id}`, { defaultValue: '' })],
        modelQuery,
      ),
    );

  if (visible.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 px-1 flex-wrap">
        <tier.icon className="h-4 w-4 text-muted-foreground self-center" />
        <h3 className="text-sm font-semibold">{t(`tier.${tier.id}`)}</h3>
        <span className="text-xs text-muted-foreground">
          {t(`tierDesc.${tier.id}`)}
        </span>
      </div>
      <Card>
        <CardContent className="p-2 space-y-0.5">
          {visible.map((model) => (
            <Ct2ModelRow
              key={model.id}
              model={model}
              isInstalled={isFasterWhisperModelInstalled(model.id, installed)}
              isDownloading={isCt2Downloading(
                model.id,
                systemInfo.downloadingModels,
              )}
              downSource={downSource}
              onUpdate={onUpdate}
              t={t}
              globalDownloading={globalDownloading}
              isRecommended={model.id === recommendedModelId}
            />
          ))}
        </CardContent>
      </Card>
    </section>
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
    systemInfo?.downloadingModels?.includes(name.toLowerCase()) ||
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
    .filter((r) =>
      matchesModelQuery(
        [r.model.name, t(`modelDesc.${r.model.name}`, { defaultValue: '' })],
        modelQuery,
      ),
    );
  const visibleVariants = variantRows
    .filter((m) => !installedOnly || isInstalled(m.name))
    .filter((m) =>
      matchesModelQuery(
        [m.name, t(`modelDesc.${m.name}`, { defaultValue: '' })],
        modelQuery,
      ),
    );

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

export interface ModelLibrarySectionProps {
  /** 渲染哪个引擎的模型清单（由主从双栏左栏选中驱动，不依赖全局引擎）。 */
  engine: TranscriptionEngine;
  systemInfo: ISystemInfo;
  systemInfoLoaded: boolean;
  globalDownloading: boolean;
  onUpdate: () => void;
}

/**
 * 引擎模型清单（按传入 `engine` 渲染：ggml 档位 / ct2 档位 / FunASR / localCli 提示）。
 * 从原 `ModelsTab` 抽出，去掉"当前引擎上下文条"，模型下载与引擎安装彻底解耦。
 */
const ModelLibrarySection: React.FC<ModelLibrarySectionProps> = ({
  engine,
  systemInfo,
  systemInfoLoaded,
  globalDownloading,
  onUpdate,
}) => {
  const { t } = useTranslation('modelsControl');
  const { t: commonT } = useTranslation('common');
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

  useEffect(() => {
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
  }, []);

  const handleDownSource = (value: string) => {
    setDownSource(value as DownSource);
  };

  const isBuiltin = engine === 'builtin';
  const isFasterWhisper = engine === 'fasterWhisper';
  const isFunasr = engine === 'funasr';
  const isQwen = engine === 'qwen';
  const isFireRed = engine === 'fireRedAsr';
  const isLocalCli = engine === 'localCli';

  const handleImportModel = async () => {
    try {
      const result = await window?.ipc?.invoke('importModel');
      if (result?.success) {
        toast.success(t('importModelSuccess'), { duration: 2000 });
        onUpdate();
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
      const pathKey = isFasterWhisper
        ? 'fasterWhisperModelsPath'
        : isFunasr
          ? 'funasrModelsPath'
          : isQwen
            ? 'qwenModelsPath'
            : isFireRed
              ? 'fireRedModelsPath'
              : 'modelsPath';
      await window?.ipc?.invoke('setSettings', {
        [pathKey]: result.directoryPath,
      });
      toast.success(t('modelPathChanged'), {
        duration: 4000,
        description: t('modelPathChangedHint'),
      });
      onUpdate();
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
      const result = await window?.ipc?.invoke('openModelsFolder', {
        pathType: isFasterWhisper
          ? 'ct2'
          : isFunasr
            ? 'funasr'
            : isQwen
              ? 'qwen'
              : isFireRed
                ? 'firered'
                : 'ggml',
      });
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

  const fwCatalog = fasterWhisperModels as FasterWhisperModelEntry[];
  const fwInstalled = systemInfo.fasterWhisperModelsInstalled ?? [];

  const recommendedCt2Id =
    recommendedId === 'largeTurbo'
      ? 'distil-large-v3'
      : recommendedId === 'large'
        ? 'large-v3'
        : recommendedId;

  const recommendedCt2Model = fwCatalog.find((m) => m.id === recommendedCt2Id);
  const recommendedCt2Installed = isFasterWhisperModelInstalled(
    recommendedCt2Id,
    fwInstalled,
  );

  const hasAnyInstalled = isBuiltin
    ? (systemInfo?.modelsInstalled?.length ?? 0) > 0
    : isFasterWhisper
      ? fwInstalled.length > 0
      : false;

  const hasVisibleGgmlModels = modelCategories.some((cat) =>
    cat.models.some((m) => {
      if (
        installedOnly &&
        !systemInfo.modelsInstalled?.includes(m.name.toLowerCase())
      ) {
        return false;
      }
      return matchesModelQuery(
        [m.name, t(`modelDesc.${m.name}`, { defaultValue: '' })],
        modelQuery,
      );
    }),
  );

  const hasVisibleCt2Models = fwCatalog.some((m) => {
    if (installedOnly && !isFasterWhisperModelInstalled(m.id, fwInstalled)) {
      return false;
    }
    return matchesModelQuery(
      [m.id, t(`modelDesc.${m.id}`, { defaultValue: '' })],
      modelQuery,
    );
  });

  const hasVisibleModels = isBuiltin
    ? hasVisibleGgmlModels
    : isFasterWhisper
      ? hasVisibleCt2Models
      : false;

  const showRecommendedHero =
    (isBuiltin && !!recommendedModel) ||
    (isFasterWhisper && !!recommendedCt2Model);
  const trimmedQuery = modelQuery.trim();

  // HuggingFace 系下载源（官方/国内镜像）：ggml/ct2/FunASR 共用同一持久化偏好。
  // 统一为「点击下载时再选源」——通过 Context 下发给真正发起下载的叶子组件，
  // 由其就地弹出气泡选源，零常驻占位。qwen/firered 自管各自源（弹窗内选）。
  const downloadSourceConfig: DownloadSourceConfig | null =
    isBuiltin || isFasterWhisper || isFunasr
      ? {
          value: downSource,
          options: [
            { value: DownSource.HuggingFace, label: t('officialSource') },
            { value: DownSource.HfMirror, label: t('domesticMirror') },
          ],
          onChange: handleDownSource,
          label: t('switchDownloadSource'),
          confirmLabel: commonT('startDownload'),
        }
      : null;

  return (
    <DownloadSourceProvider value={downloadSourceConfig}>
      <TooltipProvider delayDuration={300}>
        <div className="space-y-4">
          {showRecommendedHero && (
            <RecommendedHero
              modelName={
                isFasterWhisper
                  ? recommendedCt2Model!.id
                  : recommendedModel!.name
              }
              modelSize={
                isFasterWhisper
                  ? recommendedCt2Model!.size
                  : recommendedModel!.size
              }
              isInstalled={
                isFasterWhisper ? recommendedCt2Installed : recommendedInstalled
              }
              basis={basis}
              basisLoading={!systemInfoLoaded}
              downSource={downSource}
              onUpdate={onUpdate}
              globalDownloading={globalDownloading}
              t={t}
              format={isFasterWhisper ? 'ct2' : 'ggml'}
              needsCoreML={!isFasterWhisper && recommendedModel?.needsCoreML}
            />
          )}

          {!isLocalCli && !isFunasr && !isQwen && !isFireRed && (
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder={t('modelSearchPlaceholder')}
                  className="h-8 pl-8 pr-8 text-sm focus-visible:ring-offset-0 focus-visible:ring-inset"
                />
                {modelQuery && (
                  <button
                    type="button"
                    aria-label={t('clearSearch')}
                    onClick={() => setModelQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer shrink-0">
                <Switch
                  checked={installedOnly}
                  onCheckedChange={setInstalledOnly}
                />
                {t('showInstalledOnly')}
              </label>
              {isBuiltin && (
                <Button
                  onClick={handleImportModel}
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  {t('importModel')}
                </Button>
              )}
            </div>
          )}

          {(isBuiltin ||
            isFasterWhisper ||
            isFunasr ||
            isQwen ||
            isFireRed) && (
            <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-1 gap-y-1">
              <HardDrive className="h-3 w-3 shrink-0" />
              <span className="shrink-0">
                {isFasterWhisper
                  ? t('fasterWhisperModelsPath')
                  : t('modelPath')}
                :
              </span>
              <span className="font-mono break-all">
                {isFasterWhisper
                  ? systemInfo.fasterWhisperModelsPath
                  : isFunasr
                    ? systemInfo?.funasrModelsPath
                    : isQwen
                      ? systemInfo?.qwenModelsPath
                      : isFireRed
                        ? systemInfo?.fireRedModelsPath
                        : systemInfo?.modelsPath}
              </span>
              <button
                type="button"
                onClick={handleOpenModelsFolder}
                className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 transition-colors"
              >
                <FolderOpen className="h-3 w-3" />
                <span>{t('openModelsFolder')}</span>
              </button>
              <span className="text-faint">·</span>
              <button
                type="button"
                onClick={handleChangeModelsPath}
                className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 transition-colors"
              >
                <span>{t('changePath')}</span>
              </button>
            </div>
          )}

          {isLocalCli ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {t('localCliModelHint')}
            </p>
          ) : isFunasr ? (
            <FunasrModelSection onUpdate={onUpdate} downSource={downSource} />
          ) : isQwen ? (
            <QwenModelSection onUpdate={onUpdate} />
          ) : isFireRed ? (
            <FireRedModelSection onUpdate={onUpdate} />
          ) : installedOnly && !hasAnyInstalled ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {t('noInstalledModels')}
            </p>
          ) : trimmedQuery && !hasVisibleModels ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {t('noModelMatch')}
            </p>
          ) : isBuiltin ? (
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
                  onUpdate={onUpdate}
                  t={t}
                  globalDownloading={globalDownloading}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              {CT2_TIERS.map((tier) => (
                <FasterWhisperTierSection
                  key={tier.id}
                  tier={tier}
                  models={fwCatalog.filter((m) => m.tier === tier.id)}
                  installedOnly={installedOnly}
                  modelQuery={modelQuery}
                  recommendedModelId={recommendedCt2Id}
                  installed={fwInstalled}
                  downSource={downSource}
                  onUpdate={onUpdate}
                  t={t}
                  globalDownloading={globalDownloading}
                  systemInfo={systemInfo}
                />
              ))}
            </div>
          )}
        </div>
      </TooltipProvider>
    </DownloadSourceProvider>
  );
};

export default ModelLibrarySection;

import React, { useEffect, useState, useCallback } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
  type ModelCategory,
} from 'lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'next-i18next';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import useLocalStorageState from 'hooks/useLocalStorageState';

export enum DownSource {
  HuggingFace = 'huggingface',
  HfMirror = 'hf-mirror',
}

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

function ModelRow({
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
  t: (key: string) => string;
  globalDownloading: boolean;
}) {
  const copyToClipboard = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t('copySuccess'), { duration: 2000 }))
      .catch(() => toast.error(t('copyError'), { duration: 2000 }));
  };

  return (
    <div className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="font-mono text-sm font-medium">{model.name}</span>
        <span className="text-xs text-muted-foreground">{model.size}</span>
        {model.isQuantized && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {t('quantizedLabel')}
          </Badge>
        )}
        {model.isEnglishOnly && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {t('englishOnly')}
          </Badge>
        )}
        {isInstalled && !isDownloading && (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
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

function CategoryCard({
  category,
  isRecommended,
  systemInfo,
  downSource,
  onUpdate,
  t,
  globalDownloading,
}: {
  category: ModelCategory;
  isRecommended: boolean;
  systemInfo: ISystemInfo;
  downSource: DownSource;
  onUpdate: () => void;
  t: (key: string, opts?: any) => string;
  globalDownloading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const primaryModels = category.models.filter(
    (m) => !m.isQuantized && !m.isEnglishOnly,
  );
  const variantModels = category.models.filter(
    (m) => m.isQuantized || m.isEnglishOnly,
  );

  const installedCount = category.models.filter((m) =>
    systemInfo?.modelsInstalled?.includes(m.name.toLowerCase()),
  ).length;

  const isInstalled = (name: string) =>
    systemInfo?.modelsInstalled?.includes(name.toLowerCase());
  const isDownloading = (name: string) =>
    systemInfo?.downloadingModels?.includes(name);

  return (
    <Card className={isRecommended ? 'border-primary/50 shadow-sm' : ''}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1 flex-1">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">
                {t(`category.${category.id}`)}
              </CardTitle>
              {isRecommended && (
                <Badge className="text-[10px] px-1.5 py-0">
                  <Star className="h-3 w-3 mr-0.5" />
                  {t('recommended')}
                </Badge>
              )}
              {installedCount > 0 && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  <CheckCircle2 className="h-3 w-3 mr-0.5" />
                  {installedCount} {t('installed')}
                </Badge>
              )}
            </div>
            <CardDescription className="text-xs">
              {t(`categoryDesc.${category.id}`)}
            </CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-6 pt-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Zap className="h-3.5 w-3.5" />
            <span>{t('speed')}</span>
            <RatingDots value={category.speed} />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Target className="h-3.5 w-3.5" />
            <span>{t('quality')}</span>
            <RatingDots value={category.quality} />
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" />
            <span>{t('minRAM')}</span>
            <span className="font-medium text-foreground">
              {category.minRAM} GB
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-0.5">
          {primaryModels.map((model) => (
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

        {variantModels.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              {expanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              {expanded
                ? t('hideVariants')
                : `${t('showAllVariants')} (${variantModels.length})`}
            </button>

            {expanded && (
              <div className="space-y-0.5 mt-1">
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
                {variantModels.map((model) => (
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
  );
}

const ModelsControl = () => {
  const { t } = useTranslation('modelsControl');
  const [systemInfo, setSystemInfo] = useState<ISystemInfo>({
    modelsInstalled: [],
    downloadingModels: [],
    modelsPath: '',
  });
  const [globalDownloading, setGlobalDownloading] = useState(false);
  const [downSource, setDownSource] = useLocalStorageState<DownSource>(
    'downSource',
    DownSource.HuggingFace,
    (val) => Object.values(DownSource).includes(val as DownSource),
  );

  useEffect(() => {
    updateSystemInfo();

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

  return (
    <div className="container mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('modelManagement')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('modelManagementDesc')}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
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

      {systemInfo.totalMemoryGB && (
        <p className="text-xs text-muted-foreground">
          {t('recommendedForYou', {
            memory: systemInfo.totalMemoryGB,
            model: t(`category.${recommendedId}`),
          })}
        </p>
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

      <div className="space-y-4">
        {modelCategories.map((category) => (
          <CategoryCard
            key={category.id}
            category={category}
            isRecommended={category.id === recommendedId}
            systemInfo={systemInfo}
            downSource={downSource}
            onUpdate={updateSystemInfo}
            t={t}
            globalDownloading={globalDownloading}
          />
        ))}
      </div>
    </div>
  );
};

export default ModelsControl;

export const getStaticProps = makeStaticProperties(['common', 'modelsControl']);

export { getStaticPaths };

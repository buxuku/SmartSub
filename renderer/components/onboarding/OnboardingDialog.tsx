import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import DownModel from '@/components/DownModel';
import DownModelButton from '@/components/DownModelButton';
import useLocalStorageState from 'hooks/useLocalStorageState';
import {
  modelCategories,
  getRecommendedCategory,
  cn,
  type ModelInfo,
} from 'lib/utils';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clapperboard,
  FileText,
  Languages,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'next-i18next';

enum DownSource {
  HuggingFace = 'huggingface',
  HfMirror = 'hf-mirror',
}

interface OnboardingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时定位到的步骤（从「继续引导」入口恢复） */
  initialStep?: number;
  /** 用户从引导跳去配置页时触发：引导未完成，只是暂停 */
  onPause?: (step: number) => void;
}

interface AccelInfo {
  ready: boolean;
  descKey: string;
}

function FlowNode({
  icon: Icon,
  title,
  desc,
  highlight,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc?: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-col items-center text-center gap-1.5 w-[120px]">
      <div
        className={cn(
          'flex h-11 w-11 items-center justify-center rounded-xl',
          highlight ? 'bg-primary/10 text-primary' : 'bg-muted text-foreground',
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-xs font-medium">{title}</div>
      {desc && (
        <div className="text-[11px] text-muted-foreground leading-snug">
          {desc}
        </div>
      )}
    </div>
  );
}

const OnboardingDialog: React.FC<OnboardingDialogProps> = ({
  open,
  onOpenChange,
  initialStep = 0,
  onPause,
}) => {
  const { t } = useTranslation('common');
  const router = useRouter();
  const { locale } = router.query;

  const [step, setStep] = useState(0);
  const [totalMemoryGB, setTotalMemoryGB] = useState<number | undefined>();
  const [installedCount, setInstalledCount] = useState(0);
  const [downloadDone, setDownloadDone] = useState(false);
  const [accel, setAccel] = useState<AccelInfo>({
    ready: false,
    descKey: 'onboarding.accelDescAvailable',
  });
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
  const [downSource] = useLocalStorageState<DownSource>(
    'downSource',
    DownSource.HuggingFace,
    (val) => Object.values(DownSource).includes(val as DownSource),
  );

  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
    setDownloadDone(false);
    (async () => {
      try {
        const info = await window?.ipc?.invoke('getSystemInfo', null);
        setTotalMemoryGB(info?.totalMemoryGB);
        setInstalledCount(info?.modelsInstalled?.length ?? 0);

        const env = await window?.ipc?.invoke('get-gpu-environment');
        const active = await window?.ipc?.invoke('get-active-backend');
        if (env?.platform === 'darwin') {
          setAccel({ ready: true, descKey: 'onboarding.accelDescMac' });
        } else if (active?.backend === 'cuda') {
          setAccel({ ready: true, descKey: 'onboarding.accelDescNvidia' });
        } else if (active?.backend === 'vulkan') {
          setAccel({ ready: true, descKey: 'onboarding.accelDescVulkan' });
        } else {
          setAccel({
            ready: false,
            descKey: 'onboarding.accelDescAvailable',
          });
        }
      } catch (error) {
        console.error('Failed to load onboarding data:', error);
      }
    })();
  }, [open]);

  const recommendedId = getRecommendedCategory(totalMemoryGB ?? 8);
  const recommendedModel = modelCategories
    .find((c) => c.id === recommendedId)
    ?.models.find((m) => !m.isQuantized && !m.isEnglishOnly);
  const tinyModel = modelCategories
    .find((c) => c.id === 'tiny')
    ?.models.find((m) => !m.isQuantized && !m.isEnglishOnly);

  useEffect(() => {
    if (recommendedModel && !selectedModel) {
      setSelectedModel(recommendedModel);
    }
  }, [recommendedModel, selectedModel]);

  const markCompleted = async () => {
    try {
      await window?.ipc?.invoke('setSettings', { onboardingCompleted: true });
    } catch (error) {
      console.error('Failed to mark onboarding completed:', error);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      markCompleted();
    }
    onOpenChange(next);
  };

  /** 跳去配置页：不算完成，记为暂停，由外层提供「继续引导」入口 */
  const closeAndGo = (url: string) => {
    onPause?.(step);
    onOpenChange(false);
    router.push(url);
  };

  const choices = [
    recommendedModel && {
      model: recommendedModel,
      title: t('onboarding.recommendedChoice', {
        model: recommendedModel.name,
      }),
      desc: `${recommendedModel.size}`,
    },
    tinyModel &&
      tinyModel.name !== recommendedModel?.name && {
        model: tinyModel,
        title: t('onboarding.quickChoice'),
        desc: `${tinyModel.size} · ${t('onboarding.quickChoiceDesc')}`,
      },
  ].filter(Boolean) as { model: ModelInfo; title: string; desc: string }[];

  const steps = [
    {
      title: t('onboarding.step1Title'),
      desc: t('onboarding.step1Desc'),
      body: (
        <div className="space-y-6 py-2">
          <div className="flex items-start justify-center gap-2 flex-wrap">
            <FlowNode icon={Clapperboard} title={t('onboarding.flowVideo')} />
            <ArrowRight className="h-4 w-4 text-muted-foreground mt-3.5 flex-shrink-0" />
            <FlowNode
              icon={Bot}
              title={t('onboarding.flowModel')}
              desc={t('onboarding.flowModelDesc')}
              highlight
            />
            <ArrowRight className="h-4 w-4 text-muted-foreground mt-3.5 flex-shrink-0" />
            <FlowNode
              icon={Languages}
              title={t('onboarding.flowProvider')}
              desc={t('onboarding.flowProviderDesc')}
              highlight
            />
            <ArrowRight className="h-4 w-4 text-muted-foreground mt-3.5 flex-shrink-0" />
            <FlowNode icon={FileText} title={t('onboarding.flowSubtitle')} />
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Zap className="h-3.5 w-3.5 flex-shrink-0" />
            {t('onboarding.gpuNote')}
          </div>
        </div>
      ),
    },
    {
      title: t('onboarding.step2Title'),
      desc: t('onboarding.step2Desc'),
      body: (
        <div className="space-y-3 py-2">
          {installedCount > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-3 text-sm">
              <CheckCircle2 className="h-4 w-4 text-success" />
              {t('onboarding.modelReady')}
            </div>
          ) : (
            <>
              {choices.map(({ model, title, desc }) => (
                <button
                  key={model.name}
                  type="button"
                  onClick={() => setSelectedModel(model)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-3 text-left transition-colors',
                    selectedModel?.name === model.name
                      ? 'border-primary bg-primary/5'
                      : 'hover:bg-muted/50',
                  )}
                >
                  <div className="text-sm font-medium">{title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {desc}
                  </div>
                </button>
              ))}
              {selectedModel && (
                <div className="flex items-center gap-3 pt-1">
                  <DownModel
                    modelName={selectedModel.name}
                    callBack={() => setDownloadDone(true)}
                    downSource={downSource}
                    needsCoreML={selectedModel.needsCoreML}
                  >
                    <DownModelButton />
                  </DownModel>
                  {downloadDone && (
                    <span className="flex items-center gap-1 text-xs text-success">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t('onboarding.downloadStarted')}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ),
    },
    {
      title: t('onboarding.step3Title'),
      desc: '',
      body: (
        <div className="space-y-3 py-2">
          <div className="flex items-center gap-3 rounded-lg border px-3 py-3">
            <Languages className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {t('onboarding.providerTitle')}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t('onboarding.providerDesc')}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs flex-shrink-0"
              onClick={() => closeAndGo(`/${locale}/resources?tab=providers`)}
            >
              {t('onboarding.goConfigure')}
            </Button>
          </div>
          <div className="flex items-center gap-3 rounded-lg border px-3 py-3">
            <Zap className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium flex items-center gap-2">
                {t('onboarding.accelTitle')}
                {accel.ready && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 border-success/40 text-success"
                  >
                    {t('onboarding.enabled')}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t(accel.descKey)}
              </div>
            </div>
            {!accel.ready && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs flex-shrink-0"
                onClick={() =>
                  closeAndGo(`/${locale}/resources?tab=acceleration`)
                }
              >
                {t('onboarding.goEnable')}
              </Button>
            )}
          </div>
        </div>
      ),
    },
  ];

  const isLast = step === steps.length - 1;
  const current = steps[step];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-2xl"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{current.title}</DialogTitle>
          <DialogDescription>
            {current.desc || t('onboarding.step1Desc')}
          </DialogDescription>
        </DialogHeader>

        {current.body}

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {t('onboarding.stepLabel', {
                current: step + 1,
                total: steps.length,
              })}
            </span>
            <span className="inline-flex gap-1">
              {steps.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    i === step ? 'bg-primary' : 'bg-muted',
                  )}
                />
              ))}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => handleOpenChange(false)}
            >
              {t('onboarding.skip')}
            </Button>
            {step > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStep(step - 1)}
              >
                {t('onboarding.back')}
              </Button>
            )}
            {isLast ? (
              <Button size="sm" onClick={() => handleOpenChange(false)}>
                {t('onboarding.finish')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setStep(step + 1)}>
                {t('onboarding.next')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default OnboardingDialog;

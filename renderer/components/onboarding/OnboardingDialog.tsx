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
import { isProviderConfigured } from 'lib/providerUtils';
import { resolveEngine, getInstalledModelsForEngine } from 'lib/engineModels';
import type { TranscriptionEngine } from '../../../types/engine';
import {
  containsCjk,
  validateStoragePath,
} from '../../../types/pathValidation';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Clapperboard,
  Download,
  FileText,
  HardDrive,
  Languages,
  Loader2,
  PlayCircle,
  SkipForward,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';

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
          'flex h-11 w-11 items-center justify-center rounded-lg',
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

/** 引导内的语言切换项（语言名用本地写法，方便不识别当前界面语言的新用户辨认）。 */
const ONBOARDING_LANGS = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

const OnboardingDialog: React.FC<OnboardingDialogProps> = ({
  open,
  onOpenChange,
  initialStep = 0,
  onPause,
}) => {
  const { t, i18n } = useTranslation('common');
  const router = useRouter();
  const { locale } = router.query;
  const currentLang = (i18n.language || '').toLowerCase().startsWith('zh')
    ? 'zh'
    : 'en';

  /**
   * 引导内切换界面语言：持久化到设置，并只替换当前路由的 locale 段（保留页面与查询），
   * 避免跳回首页；界面语言随路由 locale 由 next-i18next 切换。引导面板状态在 Layout 持有，
   * 路由变化不会卸载，弹窗保持打开。
   */
  const switchLanguage = async (value: string) => {
    if (value === currentLang) return;
    try {
      await window?.ipc?.invoke('setSettings', { language: value });
    } catch (error) {
      console.error('Failed to persist language:', error);
    }
    router.push(router.asPath.replace(/^\/[^/]+/, `/${value}`));
  };

  const [step, setStep] = useState(0);
  const [totalMemoryGB, setTotalMemoryGB] = useState<number | undefined>();
  const [engine, setEngine] = useState<TranscriptionEngine>('builtin');
  const [installedCount, setInstalledCount] = useState(0);
  const [downloadDone, setDownloadDone] = useState(false);
  const [accel, setAccel] = useState<AccelInfo>({
    ready: false,
    descKey: 'onboarding.accelDescAvailable',
  });
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
  // 存储位置前置决策（unified-storage-root）：下载前改目录零迁移成本
  const [storageRoot, setStorageRoot] = useState('');
  const [userDataPath, setUserDataPath] = useState('');
  const [downSource] = useLocalStorageState<DownSource>(
    'downSource',
    DownSource.HuggingFace,
    (val) => Object.values(DownSource).includes(val as DownSource),
  );
  const [sampleLoading, setSampleLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(initialStep);
    setDownloadDone(false);
    (async () => {
      try {
        const info = await window?.ipc?.invoke('getSystemInfo', null);
        setTotalMemoryGB(info?.totalMemoryGB);
        setStorageRoot(info?.storageRoot || '');
        setUserDataPath(info?.userDataPath || '');
        // 按当前转写引擎统计已安装模型：faster-whisper 用自己的模型目录，
        // 本地命令行引擎自备模型，避免“已下载模型却提示无模型”
        const currentEngine = resolveEngine(info);
        setEngine(currentEngine);
        const modelCount =
          currentEngine === 'localCli'
            ? 1
            : getInstalledModelsForEngine(info).length;
        setInstalledCount(modelCount);

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

  // 下载前更改统一存储目录（中文路径硬校验同设置页；新装用户无模型，改目录零迁移成本）
  const handleChangeStorageDir = async () => {
    const result = await window?.ipc?.invoke('selectDirectory');
    if (result?.canceled) return;
    const selectedPath = result.directoryPath;
    if (!validateStoragePath(selectedPath).ok) {
      toast.error(t('onboarding.storageDirCjkError'));
      return;
    }
    try {
      await window?.ipc?.invoke('setSettings', { storageRoot: selectedPath });
      setStorageRoot(selectedPath);
      toast.success(t('onboarding.storageDirSaved'));
    } catch (error) {
      console.error('Failed to change storage root:', error);
    }
  };

  // 默认基座含中文且未改目录：下载前是拦截这类兼容故障的最佳时机
  const showStorageCjkWarning = !storageRoot && containsCjk(userDataPath);

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

  /**
   * 一键示例任务：固定 id，存在即删除重建——示例音频仅 10s，
   * 重建保证每次都是干净的演示，语义最简单。
   */
  const SAMPLE_PROJECT_ID = 'sample-onboarding';
  const runSample = async () => {
    setSampleLoading(true);
    try {
      const samplePath = await window?.ipc?.invoke(
        'getOnboardingSamplePath',
        null,
      );
      const providers = await window?.ipc?.invoke('getTranslationProviders');
      const userConfig = await window?.ipc?.invoke('getUserConfig');
      // 任务实际使用的是 userConfig.translateProvider,必须判它本身是否已配置,
      // 而不是「任何服务商已配置」——否则示例会拿未配置的默认服务商去翻译而报错
      const activeProvider = (providers || []).find(
        (p: any) => p.id === userConfig?.translateProvider,
      );
      const hasProvider = activeProvider
        ? isProviderConfigured(activeProvider)
        : false;
      // 已配翻译服务 → 完整链路；未配 → 纯转写，零配置可跑
      const taskType = hasProvider ? 'generateAndTranslate' : 'generateOnly';
      const slug = hasProvider ? 'generate-translate' : 'generate';

      // 删除旧示例工程后重建（deleteTaskProject 对不存在的 id 是安全 no-op）
      await window?.ipc?.invoke('deleteTaskProject', SAMPLE_PROJECT_ID);
      const dropped = await window?.ipc?.invoke('getDroppedFiles', {
        files: [samplePath],
        taskType: 'media',
      });
      if (!dropped?.length) {
        throw new Error('sample audio missing');
      }
      await window?.ipc?.invoke('saveTaskProject', {
        id: SAMPLE_PROJECT_ID,
        taskType,
        files: dropped,
        name: t('onboarding.sampleProjectName'),
      });
      markCompleted();
      onOpenChange(false);
      router.push(
        `/${locale}/tasks/${slug}?project=${SAMPLE_PROJECT_ID}&autostart=1`,
      );
    } catch (error) {
      console.error('Failed to run sample task:', error);
      toast.error(t('onboarding.sampleFailed'));
    } finally {
      setSampleLoading(false);
    }
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
          {/* 存储位置前置：下载前改目录无需迁移，已有模型的用户不展示以免误改 */}
          {installedCount === 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                <HardDrive className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground">
                    {t('onboarding.storageDirLabel')}
                  </div>
                  <div className="mt-0.5 break-all font-mono text-xs">
                    {storageRoot || userDataPath}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 flex-shrink-0 text-xs"
                  onClick={handleChangeStorageDir}
                >
                  {t('onboarding.storageDirChange')}
                </Button>
              </div>
              {showStorageCjkWarning && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <span>{t('onboarding.storageDirCjkWarning')}</span>
                </div>
              )}
            </div>
          )}
          {installedCount > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-3 text-sm">
              <CheckCircle2 className="h-4 w-4 text-success" />
              {t('onboarding.modelReady')}
            </div>
          ) : engine === 'fasterWhisper' || engine === 'funasr' ? (
            // faster-whisper / FunASR 模型走专属下载流程（资源中心-模型页），不复用 ggml 一键下载
            <div className="flex items-center gap-3 rounded-lg border px-3 py-3">
              <Bot className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {t(
                    engine === 'funasr'
                      ? 'onboarding.funasrModelTitle'
                      : 'onboarding.fasterWhisperModelTitle',
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {t(
                    engine === 'funasr'
                      ? 'onboarding.funasrModelDesc'
                      : 'onboarding.fasterWhisperModelDesc',
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs flex-shrink-0"
                onClick={() => closeAndGo(`/${locale}/engines`)}
              >
                <Download className="h-4 w-4" />
                {t('onboarding.goDownloadModel')}
              </Button>
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
              className="h-8 gap-1.5 text-xs flex-shrink-0"
              onClick={() => closeAndGo(`/${locale}/translation`)}
            >
              <Languages className="h-4 w-4" />
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
                className="h-8 gap-1.5 text-xs flex-shrink-0"
                onClick={() => {
                  // GPU 加速已折叠进 builtin 引擎面板：先选中 builtin 再跳引擎 Tab，直达加速区。
                  try {
                    localStorage.setItem(
                      'engineModelSelectedView',
                      JSON.stringify('builtin'),
                    );
                  } catch {
                    // 忽略：localStorage 不可用时仍跳转，EngineModelTab 回落默认 builtin
                  }
                  closeAndGo(`/${locale}/engines`);
                }}
              >
                <Zap className="h-4 w-4" />
                {t('onboarding.goEnable')}
              </Button>
            )}
          </div>
        </div>
      ),
    },
    {
      title: t('onboarding.step4Title'),
      desc: t('onboarding.step4Desc'),
      body: (
        <div className="space-y-3 py-2">
          <div className="rounded-lg border bg-muted/30 px-3 py-3 text-sm text-muted-foreground leading-relaxed">
            {t('onboarding.sampleExplain')}
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={runSample}
              disabled={
                sampleLoading || (installedCount === 0 && !downloadDone)
              }
            >
              {sampleLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <PlayCircle className="mr-2 h-4 w-4" />
              )}
              {sampleLoading
                ? t('onboarding.sampleRunning')
                : t('onboarding.sampleRun')}
            </Button>
            {installedCount === 0 && !downloadDone && (
              <span className="text-xs text-muted-foreground">
                {t('onboarding.sampleNeedsModel')}
              </span>
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
        {/* 语言切换：置于右上角（关闭按钮左侧），让英文用户首启即可切换、避免无从下手 */}
        <div className="absolute right-12 top-3.5 z-10 flex items-center gap-0.5 rounded-md border bg-background p-0.5">
          {ONBOARDING_LANGS.map((lang) => (
            <button
              key={lang.value}
              type="button"
              onClick={() => switchLanguage(lang.value)}
              className={cn(
                'rounded px-2 py-0.5 text-xs transition-colors',
                currentLang === lang.value
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {lang.label}
            </button>
          ))}
        </div>

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
              className="gap-1.5 text-muted-foreground"
              onClick={() => handleOpenChange(false)}
            >
              <SkipForward className="h-4 w-4" />
              {t('onboarding.skip')}
            </Button>
            {step > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setStep(step - 1)}
              >
                <ArrowLeft className="h-4 w-4" />
                {t('onboarding.back')}
              </Button>
            )}
            {isLast ? (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => handleOpenChange(false)}
              >
                <Check className="h-4 w-4" />
                {t('onboarding.finish')}
              </Button>
            ) : (
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => setStep(step + 1)}
              >
                <ArrowRight className="h-4 w-4" />
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

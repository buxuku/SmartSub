import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { toast } from 'sonner';
import Models from '@/components/Models';
import AiRefineControl from '@/components/tasks/AiRefineControl';
import GlossarySelectControl from '@/components/tasks/GlossarySelectControl';
import SummaryGenerateControl from '@/components/tasks/SummaryGenerateControl';
import ScenarioPresetControl from '@/components/tasks/ScenarioPresetControl';
import OutputFormatControl from '@/components/tasks/OutputFormatControl';
import { cn, supportedLanguage } from 'lib/utils';
import { isProviderConfigured } from 'lib/providerUtils';
import {
  hasAnyModelAnyEngine,
  hasUnavailableParakeetModel,
} from 'lib/engineModels';
import { isParakeetLanguageMismatch } from '../../../types/parakeet';
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTranslation } from 'next-i18next';
import { useCustomLanguages } from 'hooks/useCustomLanguages';
import { mergeLanguageOptions } from '../../../types/language';

interface Provider {
  id: string;
  name: string;
  type: string;
  [key: string]: any;
}

interface InlineConfigBarProps {
  form: any;
  formData: any;
  systemInfo: any;
  providers: Provider[];
  /** 云端听写服务商实例（承载于「引擎 ▸ 模型」下拉）。 */
  asrProviders?: Provider[];
  typeDef: TaskTypeDef;
  useLocalWhisper: boolean;
  refineOpen?: boolean;
  onRefineOpenChange?: (open: boolean) => void;
  /** 受控展开「生成摘要」弹层：被摘要配置阻断时由外部唤起。 */
  summaryOpen?: boolean;
  onSummaryOpenChange?: (open: boolean) => void;
  onOpenAdvanced?: () => void;
}

/**
 * 标签旁的 ⓘ 提示：说明文字收进悬停/聚焦提示，不占纵向空间。
 * 图标按钮与标签同高（h-4 = text-xs 的行高），出现与否都不会撑高标签行。
 * 按钮的可访问名称就是提示正文，读屏用户无需悬停也能听到。
 */
function ConfigItemHint({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={text}
            data-testid="config-item-hint"
            className="inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Info className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-[260px] text-xs leading-relaxed"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * 标签在上、控件在下。默认等分剩余宽度（flex-1）；
 * 内容窄且形态固定的控件（词库、摘要）通过 className 改成定宽，
 * 避免其内容变化挤压整条单行配置条。
 *
 * 标签单行截断（title 给出全称）：窄窗口下列宽不够时以省略号收尾，
 * 不会溢出盖住相邻控件。补充说明用 hint（标签旁 ⓘ）承载，而不是在控件上方
 * 另起一段文字——后者会随状态把整条配置条撑高。
 */
function ConfigItem({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col items-stretch gap-1',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span title={label} className="truncate text-xs text-muted-foreground">
          {label}
        </span>
        {hint && <ConfigItemHint text={hint} />}
      </div>
      {children}
    </div>
  );
}

const triggerClass = 'h-8 w-full min-w-0 text-xs gap-1';
const modelTriggerClass = triggerClass;

const InlineConfigBar: React.FC<InlineConfigBarProps> = ({
  form,
  formData,
  systemInfo,
  providers,
  asrProviders,
  typeDef,
  useLocalWhisper,
  refineOpen,
  onRefineOpenChange,
  summaryOpen,
  onSummaryOpenChange,
  onOpenAdvanced,
}) => {
  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const { locale } = router.query;
  const customLanguages = useCustomLanguages();
  const languageOptions = React.useMemo(
    () => mergeLanguageOptions(supportedLanguage, customLanguages),
    [customLanguages],
  );

  const setValue = (name: string, value: unknown) => {
    form.setValue(name, value, { shouldDirty: true });
  };

  const includeLocalCli = useLocalWhisper;
  const hasModels =
    hasAnyModelAnyEngine(systemInfo, asrProviders as any) || includeLocalCli;

  const languageItems = (includeAuto: boolean) => (
    <SelectContent>
      {includeAuto && (
        <SelectItem value="auto">{tHome('autoRecognition')}</SelectItem>
      )}
      {languageOptions.map((item) => (
        <SelectItem key={item.value} value={item.value}>
          {item.isCustom
            ? `${item.name} (${item.value})`
            : tCommon(`language.${item.value}`)}
        </SelectItem>
      ))}
    </SelectContent>
  );

  const { configuredProviders, unconfiguredProviders } = React.useMemo(() => {
    const configured: Provider[] = [];
    const unconfigured: Provider[] = [];
    providers.forEach((provider) => {
      if (isProviderConfigured(provider as any)) {
        configured.push(provider);
      } else {
        unconfigured.push(provider);
      }
    });
    return {
      configuredProviders: configured,
      unconfiguredProviders: unconfigured,
    };
  }, [providers]);

  const renderProviderItem = (provider: Provider, configured: boolean) => {
    const displayName = tCommon(`provider.${provider.name}`, {
      defaultValue: provider.name,
    });
    return (
      <SelectItem
        key={provider.id}
        value={provider.id}
        textValue={displayName}
        disabled={!configured}
      >
        <div className="flex w-full items-center justify-between gap-3">
          <span className="truncate">{displayName}</span>
          <span className="flex flex-none items-center gap-1.5">
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium leading-none',
                provider.isAi
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {provider.isAi
                ? t('configBar.tagAi')
                : t('configBar.tagTraditional')}
            </span>
            {!configured && (
              <span className="text-[10px] text-muted-foreground">
                {t('notConfigured')}
              </span>
            )}
          </span>
        </div>
      </SelectItem>
    );
  };

  const handleTranslateProviderChange = (newProviderId: string) => {
    setValue('translateProvider', newProviderId);
    const newProvider = providers.find((p) => p.id === newProviderId);
    const isRefineOn =
      formData?.aiSegmentation === true || formData?.aiCorrection === true;
    const refineSetting = formData?.refineProvider || 'follow-translation';
    if (
      isRefineOn &&
      refineSetting === 'follow-translation' &&
      newProvider &&
      !newProvider.isAi
    ) {
      const featureName =
        formData?.aiSegmentation && formData?.aiCorrection
          ? t('wizard.refineFeatureBoth')
          : formData?.aiCorrection
            ? t('wizard.refineFeatureCorrection')
            : t('wizard.refineFeatureSegmentation');
      const pName = tCommon(`provider.${newProvider.name}`, {
        defaultValue: newProvider.name,
      });
      toast.warning(
        t('configBar.toastTraditionalRefineConflict', {
          provider: pName,
          feature: featureName,
        }),
        { duration: 6000 },
      );
    }
  };

  const selectedTranslateProvider = providers.find(
    (p) => p.id === formData.translateProvider,
  );
  const selectedTranslateProviderName = selectedTranslateProvider
    ? tCommon(`provider.${selectedTranslateProvider.name}`, {
        defaultValue: selectedTranslateProvider.name,
      })
    : undefined;

  return (
    <div
      className="task-inspector flex min-w-0 flex-col gap-1.5 w-full"
      data-testid="task-inspector"
    >
      <div className="inspector-sections bg-muted/30 px-3 py-2 w-full rounded-md overflow-x-auto">
        <div
          className="flex min-w-0 items-end gap-2.5 flex-nowrap w-full"
          data-testid="task-inspector-core"
        >
          {typeDef.needsModel && (
            <ConfigItem label={t('configBar.model')}>
              {hasModels || formData.transcriptionEngine === 'parakeet' ? (
                <Models
                  className={modelTriggerClass}
                  engine={formData.transcriptionEngine}
                  model={formData.model}
                  asrProviderId={formData.asrProviderId}
                  asrProviders={asrProviders as any}
                  onChange={(engine, model, asrProviderId) => {
                    setValue('transcriptionEngine', engine);
                    setValue('model', model);
                    setValue('asrProviderId', asrProviderId ?? '');
                  }}
                  modelsInstalled={systemInfo?.modelsInstalled || []}
                  fasterWhisperModelsInstalled={
                    systemInfo?.fasterWhisperModelsInstalled
                  }
                  funasrVadInstalled={systemInfo?.funasrVadInstalled}
                  funasrAsrModelsInstalled={
                    systemInfo?.funasrAsrModelsInstalled
                  }
                  pythonEngineStatus={systemInfo?.pythonEngineStatus}
                  funasrEngineInstalled={systemInfo?.funasrEngineInstalled}
                  qwenVadInstalled={systemInfo?.qwenVadInstalled}
                  qwenModelsInstalled={systemInfo?.qwenModelsInstalled}
                  qwenEngineInstalled={systemInfo?.qwenEngineInstalled}
                  fireRedVadInstalled={systemInfo?.fireRedVadInstalled}
                  fireRedModelsInstalled={systemInfo?.fireRedModelsInstalled}
                  fireRedEngineInstalled={systemInfo?.fireRedEngineInstalled}
                  parakeetVadInstalled={systemInfo?.parakeetVadInstalled}
                  parakeetModelsInstalled={systemInfo?.parakeetModelsInstalled}
                  parakeetEngineInstalled={systemInfo?.parakeetEngineInstalled}
                  includeLocalCli={includeLocalCli}
                />
              ) : (
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="h-8 w-full min-w-0 px-2 text-xs"
                >
                  <Link
                    href={`/${locale}/engines`}
                    title={t('goDownloadModel')}
                  >
                    <span className="truncate">{t('goDownloadModel')}</span>
                  </Link>
                </Button>
              )}
            </ConfigItem>
          )}

          <ConfigItem
            label={
              typeDef.accepts === 'subtitle'
                ? t('configBar.subtitleSourceLanguage')
                : t('configBar.sourceLanguage')
            }
          >
            <Select
              value={formData.sourceLanguage}
              onValueChange={(v) => setValue('sourceLanguage', v)}
            >
              <SelectTrigger
                className={triggerClass}
                aria-label={t('configBar.sourceLanguage')}
              >
                <SelectValue placeholder={tHome('pleaseSelect')} />
              </SelectTrigger>
              {languageItems(true)}
            </Select>
          </ConfigItem>

          {typeDef.hasTranslate && (
            <>
              <ConfigItem label={t('configBar.targetLanguage')}>
                <Select
                  value={formData.targetLanguage}
                  onValueChange={(v) => setValue('targetLanguage', v)}
                >
                  <SelectTrigger
                    className={triggerClass}
                    aria-label={t('configBar.targetLanguage')}
                  >
                    <SelectValue placeholder={tHome('pleaseSelect')} />
                  </SelectTrigger>
                  {languageItems(false)}
                </Select>
              </ConfigItem>

              <ConfigItem
                label={t('configBar.provider')}
                hint={
                  formData.translateProvider === 'autoFree'
                    ? tHome('freeTranslationNetworkHint')
                    : undefined
                }
              >
                {providers.length > 0 ? (
                  <Select
                    value={formData.translateProvider}
                    onValueChange={handleTranslateProviderChange}
                  >
                    <SelectTrigger
                      className={triggerClass}
                      aria-label={t('configBar.provider')}
                    >
                      <SelectValue placeholder={tHome('pleaseSelect')}>
                        {selectedTranslateProviderName}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {configuredProviders.length > 0 && (
                        <SelectGroup>
                          <SelectLabel className="flex items-center gap-1.5 pl-2 text-foreground">
                            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                            {t('providerGroup.configured')}
                          </SelectLabel>
                          {configuredProviders.map((provider) =>
                            renderProviderItem(provider, true),
                          )}
                        </SelectGroup>
                      )}
                      {unconfiguredProviders.length > 0 && (
                        <SelectGroup>
                          <SelectLabel className="flex items-center gap-1.5 pl-2 text-muted-foreground">
                            <AlertCircle className="h-3.5 w-3.5" />
                            {t('providerGroup.notConfigured')}
                          </SelectLabel>
                          {unconfiguredProviders.map((provider) =>
                            renderProviderItem(provider, false),
                          )}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                ) : (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="h-8 w-full min-w-0 px-2 text-xs"
                  >
                    <Link
                      href={`/${locale}/translation`}
                      title={t('goConfigureProvider')}
                    >
                      <span className="truncate">
                        {t('goConfigureProvider')}
                      </span>
                    </Link>
                  </Button>
                )}
              </ConfigItem>
              {/* 定宽：最小窗口(1024)下与其余控件同样紧凑，宽屏(≥1280)多给 8~16px，
                  让默认文案「全局已启用」「DeepSeek」不被省略号截断 */}
              <ConfigItem
                label={t('configBar.glossary')}
                className="w-[120px] flex-none xl:w-[128px]"
              >
                <GlossarySelectControl form={form} formData={formData} />
              </ConfigItem>
              <ConfigItem
                label={t('configBar.generateSummary')}
                className="w-[112px] flex-none xl:w-[128px]"
              >
                <SummaryGenerateControl
                  form={form}
                  formData={formData}
                  providers={providers}
                  open={summaryOpen}
                  onOpenChange={onSummaryOpenChange}
                />
              </ConfigItem>
            </>
          )}

          {typeDef.needsModel && (
            <>
              <ConfigItem label={t('configBar.scenario')}>
                <ScenarioPresetControl
                  form={form}
                  formData={formData}
                  onOpenAdvanced={onOpenAdvanced}
                />
              </ConfigItem>
              <ConfigItem label={t('refine.control.label')}>
                <AiRefineControl
                  form={form}
                  formData={formData}
                  providers={providers}
                  typeDef={typeDef}
                  open={refineOpen}
                  onOpenChange={onRefineOpenChange}
                />
              </ConfigItem>
            </>
          )}

          <ConfigItem label={t('configBar.format')}>
            <OutputFormatControl
              form={form}
              formData={formData}
              typeDef={typeDef}
            />
          </ConfigItem>
        </div>
      </div>
      <style jsx>{`
        .task-inspector {
          container-type: inline-size;
        }
      `}</style>

      {typeDef.needsModel &&
        formData.transcriptionEngine === 'parakeet' &&
        (hasUnavailableParakeetModel(systemInfo, formData) ? (
          <p
            role="alert"
            className="flex w-full items-start gap-1.5 break-words text-xs text-destructive px-1"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            {t('parakeet.modelUnavailable', {
              model: formData.model || 'Parakeet',
            })}
          </p>
        ) : isParakeetLanguageMismatch(
            formData.model,
            formData.sourceLanguage,
          ) ? (
          <p
            role="status"
            className="flex w-full items-start gap-1.5 break-words text-xs text-muted-foreground px-1"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            {t('parakeet.languageMismatch', {
              model: formData.model,
              language: formData.sourceLanguage,
            })}
          </p>
        ) : null)}
    </div>
  );
};

export default InlineConfigBar;

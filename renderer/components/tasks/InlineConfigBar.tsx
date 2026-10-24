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
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import Models from '@/components/Models';
import AiRefineControl from '@/components/tasks/AiRefineControl';
import ConfigItemHint from '@/components/tasks/ConfigItemHint';
import GlossarySelectControl from '@/components/tasks/GlossarySelectControl';
import SummaryGenerateControl from '@/components/tasks/SummaryGenerateControl';
import ScenarioPresetControl from '@/components/tasks/ScenarioPresetControl';
import OutputFormatControl from '@/components/tasks/OutputFormatControl';
import SettingsFields from './settings/SettingsFields';
import type { TaskSettingsTab } from '@/components/tasks/settings/types';
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
  disabled?: boolean;
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
  /** Opens 更多设置 (the scenario popover's footer links ask for a page). */
  onOpenSettings?: (tab?: TaskSettingsTab) => void;
}

/**
 * 标签在上、控件在下。按内容保留紧凑宽度，空间不足时自然换行。
 */
function ConfigItem({
  label,
  hint,
  children,
  width = 120,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      className="flex min-w-0 flex-col items-stretch gap-1"
      style={{ flexBasis: width }}
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
  disabled = false,
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
  onOpenSettings,
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
      <SettingsFields
        disabled={disabled}
        data-testid="task-inspector-core"
        onClickCapture={(event) => {
          if (disabled) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {typeDef.needsModel && (
          <ConfigItem label={t('configBar.model')} width={160}>
            {hasModels ||
            formData.transcriptionEngine === 'parakeet' ||
            (disabled && formData.model) ? (
              <Models
                compact
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
                funasrAsrModelsInstalled={systemInfo?.funasrAsrModelsInstalled}
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
                <Link href={`/${locale}/engines`} title={t('goDownloadModel')}>
                  <span className="truncate">{t('goDownloadModel')}</span>
                </Link>
              </Button>
            )}
          </ConfigItem>
        )}

        <ConfigItem
          width={80}
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

        {typeDef.needsModel && (
          <>
            <ConfigItem label={t('configBar.scenario')} width={112}>
              <ScenarioPresetControl
                form={form}
                formData={formData}
                onOpenSettings={onOpenSettings}
              />
            </ConfigItem>
            <ConfigItem label={t('refine.control.label')} width={112}>
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

        {typeDef.hasTranslate && (
          <>
            <ConfigItem label={t('configBar.targetLanguage')} width={80}>
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
                    title={selectedTranslateProviderName}
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
                    <span className="truncate">{t('goConfigureProvider')}</span>
                  </Link>
                </Button>
              )}
            </ConfigItem>
            <ConfigItem label={t('configBar.glossary')} width={96}>
              <GlossarySelectControl form={form} formData={formData} />
            </ConfigItem>
            <ConfigItem label={t('configBar.generateSummary')} width={96}>
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

        <ConfigItem label={t('configBar.output')} width={136}>
          <OutputFormatControl
            compact
            form={form}
            formData={formData}
            typeDef={typeDef}
          />
        </ConfigItem>
      </SettingsFields>

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

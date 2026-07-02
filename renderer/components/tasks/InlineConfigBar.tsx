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
import { AlertCircle, CheckCircle2, Download, Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Models from '@/components/Models';
import { supportedLanguage } from 'lib/utils';
import { isProviderConfigured } from 'lib/providerUtils';
import { hasAnyModelAnyEngine } from 'lib/engineModels';
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTranslation } from 'next-i18next';

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
}

function ConfigItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {label}
      </span>
      {children}
    </div>
  );
}

const triggerClass = 'h-8 w-auto min-w-[120px] max-w-[200px] text-xs gap-1';
// 模型选择器需容纳「引擎 · 模型」两段文本，略宽于其它选择器
const modelTriggerClass =
  'h-8 w-auto min-w-[160px] max-w-[260px] text-xs gap-1';

const InlineConfigBar: React.FC<InlineConfigBarProps> = ({
  form,
  formData,
  systemInfo,
  providers,
  asrProviders,
  typeDef,
  useLocalWhisper,
}) => {
  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');
  const { t: tCommon } = useTranslation('common');
  const router = useRouter();
  const { locale } = router.query;

  const setValue = (name: string, value: unknown) => {
    form.setValue(name, value);
  };

  // localCli 走"自备模型/命令"路径，无可下载模型，按是否启用 localCli 决定是否进分组下拉。
  // 过渡期沿用 useLocalWhisper 作为 localCli 启用信号（全局字段移除时改用 localCli 已配置判断）。
  const includeLocalCli = useLocalWhisper;
  // 就绪 = 跨引擎任一已装模型 / 任一已配置云实例 / 启用了 localCli（自备模型）；否则引导去下载。
  const hasModels =
    hasAnyModelAnyEngine(systemInfo, asrProviders as any) || includeLocalCli;

  const languageItems = (includeAuto: boolean) => (
    <SelectContent>
      {includeAuto && (
        <SelectItem value="auto">{tHome('autoRecognition')}</SelectItem>
      )}
      {supportedLanguage.map((item) => (
        <SelectItem key={item.value} value={item.value}>
          {tCommon(`language.${item.value}`)}
        </SelectItem>
      ))}
    </SelectContent>
  );

  // 已配置的服务商前置并独立分组，未配置的灰色置后：兼顾「可用项触手可及」与「发现性」
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

  const renderProviderItem = (provider: Provider, configured: boolean) => (
    <SelectItem key={provider.id} value={provider.id} disabled={!configured}>
      {tCommon(`provider.${provider.name}`, { defaultValue: provider.name })}
      {!configured && t('notConfigured')}
    </SelectItem>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2">
      {typeDef.needsModel && (
        <ConfigItem label={t('configBar.model')}>
          {hasModels ? (
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
              funasrAsrModelsInstalled={systemInfo?.funasrAsrModelsInstalled}
              pythonEngineStatus={systemInfo?.pythonEngineStatus}
              funasrEngineInstalled={systemInfo?.funasrEngineInstalled}
              qwenVadInstalled={systemInfo?.qwenVadInstalled}
              qwenModelsInstalled={systemInfo?.qwenModelsInstalled}
              qwenEngineInstalled={systemInfo?.qwenEngineInstalled}
              fireRedVadInstalled={systemInfo?.fireRedVadInstalled}
              fireRedModelsInstalled={systemInfo?.fireRedModelsInstalled}
              fireRedEngineInstalled={systemInfo?.fireRedEngineInstalled}
              includeLocalCli={includeLocalCli}
            />
          ) : (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
            >
              <Link href={`/${locale}/engines`}>
                <Download className="h-4 w-4" />
                {t('goDownloadModel')}
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
          <SelectTrigger className={triggerClass}>
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
              <SelectTrigger className={triggerClass}>
                <SelectValue placeholder={tHome('pleaseSelect')} />
              </SelectTrigger>
              {languageItems(false)}
            </Select>
          </ConfigItem>

          <ConfigItem label={t('configBar.provider')}>
            {providers.length > 0 ? (
              <Select
                value={formData.translateProvider}
                onValueChange={(v) => setValue('translateProvider', v)}
              >
                <SelectTrigger className={triggerClass}>
                  <SelectValue placeholder={tHome('pleaseSelect')} />
                </SelectTrigger>
                <SelectContent>
                  {configuredProviders.length > 0 && (
                    <SelectGroup>
                      <SelectLabel className="flex items-center gap-1.5 pl-2 text-foreground">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
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
                className="h-8 text-xs gap-1.5"
              >
                <Link href={`/${locale}/translation`}>
                  <Languages className="h-4 w-4" />
                  {t('goConfigureProvider')}
                </Link>
              </Button>
            )}
          </ConfigItem>

          <ConfigItem label={t('configBar.style')}>
            <Select
              value={formData.translateContent}
              onValueChange={(v) => setValue('translateContent', v)}
            >
              <SelectTrigger className={triggerClass}>
                <SelectValue placeholder={tHome('pleaseSelect')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="onlyTranslate">
                  {tHome('onlyOutputTranslationSubtitle')}
                </SelectItem>
                <SelectItem value="sourceAndTranslate">
                  {tHome('sourceAndTranslate')}
                </SelectItem>
                <SelectItem value="translateAndSource">
                  {tHome('translateAndSource')}
                </SelectItem>
              </SelectContent>
            </Select>
          </ConfigItem>
        </>
      )}

      {!typeDef.hasTranslate && (
        <ConfigItem label={t('configBar.format')}>
          <Select
            value={formData.subtitleOutputFormat || 'srt'}
            onValueChange={(v) => setValue('subtitleOutputFormat', v)}
          >
            <SelectTrigger className={triggerClass}>
              <SelectValue placeholder={tHome('pleaseSelect')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="srt">{tHome('format_srt')}</SelectItem>
              <SelectItem value="vtt">{tHome('format_vtt')}</SelectItem>
              <SelectItem value="ass">{tHome('format_ass')}</SelectItem>
              <SelectItem value="lrc">{tHome('format_lrc')}</SelectItem>
              <SelectItem value="txt">{tHome('format_txt')}</SelectItem>
            </SelectContent>
          </Select>
        </ConfigItem>
      )}
    </div>
  );
};

export default InlineConfigBar;

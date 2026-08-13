/**
 * 任务配置条：通读摘要开关 + 独立 AI 服务商。
 * 字段层可用 follow-translation 哨兵；下拉只列已配置 AI，不出现「跟随」条目。
 */
import React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTranslation } from 'next-i18next';
import { isProviderConfigured } from 'lib/providerUtils';
import { FOLLOW_TRANSLATION_PROVIDER } from '../../../types/summaryPrompt';

interface Provider {
  id: string;
  name: string;
  isAi?: boolean;
  [key: string]: any;
}

interface SummaryGenerateControlProps {
  form: any;
  formData: any;
  providers: Provider[];
}

const SummaryGenerateControl: React.FC<SummaryGenerateControlProps> = ({
  form,
  formData,
  providers,
}) => {
  const { t } = useTranslation('tasks');
  const { t: tCommon } = useTranslation('common');

  const setValue = (name: string, value: unknown) =>
    form.setValue(name, value, { shouldDirty: true });

  const enabled = formData?.generateSummary === true;
  const aiProviders = providers.filter(
    (provider) => provider.isAi && isProviderConfigured(provider as any),
  );
  const translateProvider = providers.find(
    (provider) => provider.id === formData?.translateProvider,
  );
  const translateIsAi = Boolean(
    translateProvider?.isAi && isProviderConfigured(translateProvider as any),
  );
  const setting = formData?.summaryProvider || FOLLOW_TRANSLATION_PROVIDER;
  const following = setting === FOLLOW_TRANSLATION_PROVIDER;
  const selectValue = following
    ? translateIsAi
      ? translateProvider!.id
      : ''
    : setting;
  const injectsIntoTranslate = Boolean(translateProvider?.isAi);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {t('configBar.generateSummary')}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setValue('generateSummary', checked)}
        />
      </div>
      {enabled && (
        <>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {t('configBar.summaryProvider')}
            </span>
            {aiProviders.length > 0 ? (
              <Select
                value={selectValue || undefined}
                onValueChange={(value) => setValue('summaryProvider', value)}
              >
                <SelectTrigger className="h-8 w-auto min-w-[140px] max-w-[220px] text-xs gap-1">
                  <SelectValue
                    placeholder={t('configBar.summaryProviderPlaceholder')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {aiProviders.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {tCommon(`provider.${provider.name}`, {
                        defaultValue: provider.name,
                      })}
                      {following &&
                        translateIsAi &&
                        provider.id === translateProvider?.id &&
                        t('configBar.summaryFollowHint')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-xs text-warning">
                {t('configBar.summaryProviderMissing')}
              </span>
            )}
          </div>
          <p className="w-full text-[11px] leading-relaxed text-muted-foreground">
            {t('configBar.summarySkipHint')}
            {!injectsIntoTranslate && (
              <> {t('configBar.summaryNotInjectedHint')}</>
            )}
          </p>
        </>
      )}
    </div>
  );
};

export default SummaryGenerateControl;

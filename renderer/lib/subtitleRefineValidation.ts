import { isProviderConfigured } from '../../types/provider';
import type { Provider } from '../../types/provider';

export type RefineValidationErrorReason =
  | 'translation-off'
  | 'translation-needs-ai'
  | 'translation-unconfigured'
  | 'provider-invalid'
  | 'provider-needs-ai'
  | 'provider-unconfigured';

export type RefineActiveFeature = 'both' | 'segmentation' | 'correction' | null;

export interface RefineValidationResult {
  valid: boolean;
  isRefineActive: boolean;
  feature: RefineActiveFeature;
  setting: string;
  isFollow: boolean;
  provider: Provider | null;
  reason?: RefineValidationErrorReason;
}

/**
 * 校验任务配置中 AI 字幕精修（AI 语义断句与 AI 文本校正）的服务商有效性。
 *
 * 规则：
 * 1. 若未开启任一 AI 精修功能（aiSegmentation 与 aiCorrection 均未开启），视为无需精修，直接返回 valid: true。
 * 2. 精修服务商设为「跟随翻译服务」（follow-translation）：
 *    - 翻译必须开启（translateOn = true）且选定了翻译服务商；
 *    - 翻译服务商必须为 AI/大模型类型（isAi = true）；
 *    - 翻译服务商必须已完成必要配置（通过 isProviderConfigured 校验）。
 * 3. 精修服务商设为显式指定（某一服务商 id）：
 *    - 该服务商必须在 providers 列表中存在；
 *    - 该服务商必须为 AI/大模型类型（isAi = true）；
 *    - 该服务商必须已完成必要配置（通过 isProviderConfigured 校验）。
 */
export function validateRefineProviderConfig({
  formData,
  providers,
  translateOn,
}: {
  formData?: Record<string, any>;
  providers: Provider[];
  translateOn: boolean;
}): RefineValidationResult {
  const isSegOn = formData?.aiSegmentation === true;
  const isCorrOn = formData?.aiCorrection === true;
  const isRefineActive = isSegOn || isCorrOn;

  if (!isRefineActive) {
    return {
      valid: true,
      isRefineActive: false,
      feature: null,
      setting: 'follow-translation',
      isFollow: true,
      provider: null,
    };
  }

  const feature: RefineActiveFeature =
    isSegOn && isCorrOn ? 'both' : isCorrOn ? 'correction' : 'segmentation';

  const setting = String(formData?.refineProvider || 'follow-translation');
  const isFollow = setting === 'follow-translation';

  if (isFollow) {
    if (!translateOn) {
      return {
        valid: false,
        isRefineActive: true,
        feature,
        setting,
        isFollow: true,
        provider: null,
        reason: 'translation-off',
      };
    }

    const translateId = String(formData?.translateProvider ?? '-1');
    const tp = providers.find((p) => p.id === translateId);
    if (!tp) {
      return {
        valid: false,
        isRefineActive: true,
        feature,
        setting,
        isFollow: true,
        provider: null,
        reason: 'translation-off',
      };
    }

    if (!tp.isAi) {
      return {
        valid: false,
        isRefineActive: true,
        feature,
        setting,
        isFollow: true,
        provider: tp,
        reason: 'translation-needs-ai',
      };
    }

    if (!isProviderConfigured(tp)) {
      return {
        valid: false,
        isRefineActive: true,
        feature,
        setting,
        isFollow: true,
        provider: tp,
        reason: 'translation-unconfigured',
      };
    }

    return {
      valid: true,
      isRefineActive: true,
      feature,
      setting,
      isFollow: true,
      provider: tp,
    };
  }

  // 显式指定服务商
  const rp = providers.find((p) => p.id === setting);
  if (!rp) {
    return {
      valid: false,
      isRefineActive: true,
      feature,
      setting,
      isFollow: false,
      provider: null,
      reason: 'provider-invalid',
    };
  }

  if (!rp.isAi) {
    return {
      valid: false,
      isRefineActive: true,
      feature,
      setting,
      isFollow: false,
      provider: rp,
      reason: 'provider-needs-ai',
    };
  }

  if (!isProviderConfigured(rp)) {
    return {
      valid: false,
      isRefineActive: true,
      feature,
      setting,
      isFollow: false,
      provider: rp,
      reason: 'provider-unconfigured',
    };
  }

  return {
    valid: true,
    isRefineActive: true,
    feature,
    setting,
    isFollow: false,
    provider: rp,
  };
}

/**
 * 将校验失败原因转换为对用户友好的多语言文本。
 */
export function getRefineValidationErrorMessage(
  result: RefineValidationResult,
  t: (key: string, options?: any) => string,
  commonT: (key: string, options?: any) => string,
): string {
  if (result.valid) return '';

  const featureName =
    result.feature === 'both'
      ? t('wizard.refineFeatureBoth')
      : result.feature === 'correction'
        ? t('wizard.refineFeatureCorrection')
        : t('wizard.refineFeatureSegmentation');

  if (result.reason === 'translation-off') {
    return t('wizard.blockRefineFollowTranslationOff', {
      feature: featureName,
    });
  }

  if (result.reason === 'translation-needs-ai') {
    const providerDisplayName = result.provider
      ? commonT(`provider.${result.provider.name}`, {
          defaultValue: result.provider.name,
        })
      : '';
    return t('wizard.blockRefineFollowNeedsAi', {
      feature: featureName,
      provider: providerDisplayName,
    });
  }

  return t('wizard.blockRefineProviderInvalid');
}

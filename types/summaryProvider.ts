/**
 * 摘要服务商的纯判定。渲染层与主进程共用，不依赖 node / electron。
 */
import type { Provider } from './provider';
import { isProviderConfigured } from './providerUtils';
import {
  FOLLOW_TRANSLATION_PROVIDER,
  type SummaryErrorCode,
} from './summaryPrompt';

export interface SummaryProviderResolution {
  provider: Provider | null;
  source: 'follow' | 'explicit';
  reason?: SummaryErrorCode;
}

type SummaryProviderForm =
  | {
      summaryProvider?: unknown;
      translateProvider?: unknown;
    }
  | null
  | undefined;

function summaryProviderSetting(
  formData: Record<string, unknown> | undefined,
): string {
  return String(formData?.summaryProvider || FOLLOW_TRANSLATION_PROVIDER);
}

function providerForSummarySource(
  source: 'follow' | 'explicit',
  formData: Record<string, unknown> | undefined,
  providers: Provider[],
): Provider | undefined {
  const id =
    source === 'follow'
      ? String(formData?.translateProvider ?? '-1')
      : summaryProviderSetting(formData);
  return providers.find((item) => item.id === id);
}

/** 未找到、非 AI、必填项未填时降级；顺序固定，非 AI 不再查配置。 */
function decideSummaryProvider(
  source: 'follow' | 'explicit',
  provider: Provider | undefined,
): SummaryProviderResolution {
  if (!provider) {
    return { provider: null, source, reason: 'provider-unresolved' };
  }
  if (!provider.isAi) {
    return { provider: null, source, reason: 'provider-not-ai' };
  }
  if (!isProviderConfigured(provider)) {
    return { provider: null, source, reason: 'provider-unconfigured' };
  }
  return { provider, source };
}

/** 纯判定。跟随翻译服务，或按 id 取显式摘要服务。 */
export function pickSummaryProvider(
  formData: Record<string, unknown> | undefined,
  providers: Provider[],
): SummaryProviderResolution {
  const source =
    summaryProviderSetting(formData) === FOLLOW_TRANSLATION_PROVIDER
      ? 'follow'
      : 'explicit';
  return decideSummaryProvider(
    source,
    providerForSummarySource(source, formData, providers),
  );
}

function summaryFormRecord(
  formData: SummaryProviderForm,
): Record<string, unknown> | undefined {
  if (formData == null) return undefined;
  return {
    summaryProvider: formData.summaryProvider,
    translateProvider: formData.translateProvider,
  };
}

/**
 * 与 pickSummaryProvider 同一判定。
 * 解析出可用服务商返回 null；否则跟随为 follow，显式指定为 invalid。
 */
export function validateSummaryProvider(
  formData: SummaryProviderForm,
  providers: Provider[],
): null | 'follow' | 'invalid' {
  const resolved = pickSummaryProvider(summaryFormRecord(formData), providers);
  if (resolved.provider) return null;
  return resolved.source === 'follow' ? 'follow' : 'invalid';
}

/**
 * 配置条上的服务商列表类型不保证带 isAi。
 * 缺省按非 AI 处理，真正交给 isProviderConfigured 时补成 boolean。
 */
export type SummaryControlProvider = Omit<Provider, 'isAi'> & {
  isAi?: boolean;
};

/** 已配置的 AI 服务商才能出现在摘要下拉，或充当跟随目标。 */
export function isUsableSummaryProvider(
  provider: SummaryControlProvider | undefined,
): boolean {
  if (!provider?.isAi) return false;
  return isProviderConfigured({
    ...provider,
    id: provider.id,
    name: provider.name,
    type: provider.type,
    isAi: true,
  });
}

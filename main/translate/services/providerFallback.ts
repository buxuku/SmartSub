import type { Provider, TranslatorFunction } from '../types';
import { isFallbackEligibleError } from '../utils/error';
import { acquireProviderRequestSlot } from '../utils/providerRequestScheduler';
import { acquire, resolveRateLimitConfig } from '../utils/rateLimiter';
import { isProviderConfigured } from '../../../types/provider';
import {
  isTaskCancelledError,
  throwIfSignalCancelled,
} from '../../helpers/taskContext';

export type ProviderFallbackEvent = {
  from: Provider;
  to: Provider;
  reason: string;
};

export type ProviderFallbackRunnerOptions = {
  primary: Provider;
  fallbacks?: Provider[];
  resolveTranslator: (provider: Provider) => TranslatorFunction | undefined;
  signal?: AbortSignal;
  onFallback?: (event: ProviderFallbackEvent) => void;
  log?: (message: string, type: 'info' | 'warning' | 'error') => void;
};

function sanitizeFallbackReason(reason: string, providers: Provider[]): string {
  let sanitized = reason;
  for (const provider of providers) {
    for (const [key, value] of Object.entries(provider)) {
      if (
        !/(?:api)?key|secret|appid|token|password|access.?id/i.test(key) ||
        typeof value !== 'string' ||
        value.length < 6
      ) {
        continue;
      }
      sanitized = sanitized.split(value).join('[redacted]');
    }
  }
  return sanitized.replace(/\b(?:sk|pk|ak)-[a-z0-9_-]{6,}\b/gi, '[redacted]');
}

/** 全部同 type 实例均失败时抛出的错误，保留最后一个错误供上层处理。 */
export class ProviderFallbackExhaustedError extends Error {
  readonly providers: Provider[];
  readonly causeError: unknown;

  constructor(providers: Provider[], causeError: unknown) {
    const reason =
      causeError instanceof Error
        ? causeError.message
        : String(causeError ?? 'unknown error');
    const names = providers
      .map((provider) => provider.name || provider.id)
      .join(' -> ');
    super(
      `同类型翻译服务均不可用（${names}）：${sanitizeFallbackReason(reason, providers)}`,
    );
    this.name = 'ProviderFallbackExhaustedError';
    this.providers = providers;
    this.causeError = causeError;
  }
}

/**
 * 任务级同 type 回退状态机。
 * 成功后保持当前实例；已触发回退的实例在当前任务内不会再次尝试。
 */
export class ProviderFallbackRunner {
  private readonly candidates: Provider[];
  private readonly resolveTranslator: ProviderFallbackRunnerOptions['resolveTranslator'];
  private readonly signal?: AbortSignal;
  private readonly onFallback?: ProviderFallbackRunnerOptions['onFallback'];
  private readonly log: NonNullable<ProviderFallbackRunnerOptions['log']>;
  private readonly failed = new Set<string>();
  private activeIndex = 0;
  private exhaustedError?: ProviderFallbackExhaustedError;

  constructor(options: ProviderFallbackRunnerOptions) {
    const seen = new Set<string>();
    this.candidates = [options.primary, ...(options.fallbacks ?? [])].filter(
      (provider) => {
        if (!provider || provider.type !== options.primary.type) return false;
        if (
          provider.id !== options.primary.id &&
          !isProviderConfigured(provider)
        )
          return false;
        if (seen.has(provider.id)) return false;
        seen.add(provider.id);
        return true;
      },
    );
    this.resolveTranslator = options.resolveTranslator;
    this.signal = options.signal;
    this.onFallback = options.onFallback;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  get currentProvider(): Provider {
    return this.candidates[this.activeIndex] ?? this.candidates[0];
  }

  get hasFallbacks(): boolean {
    return this.candidates.length > 1;
  }

  async run<T>(
    operation: (
      provider: Provider,
      translator: TranslatorFunction,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.exhaustedError) throw this.exhaustedError;
    let index = this.activeIndex;
    let lastError: unknown;

    while (index < this.candidates.length) {
      if (this.exhaustedError) throw this.exhaustedError;
      const provider = this.candidates[index];
      if (this.failed.has(provider.id)) {
        index += 1;
        continue;
      }

      throwIfSignalCancelled(this.signal);
      const translator = this.resolveTranslator(provider);
      if (!translator) {
        throw new Error(`Unknown translation provider: ${provider.type}`);
      }

      const release = await acquireProviderRequestSlot(provider, this.signal);
      try {
        if (this.exhaustedError) throw this.exhaustedError;
        if (this.failed.has(provider.id)) {
          index += 1;
          continue;
        }
        let firstRequest = true;
        const scheduledTranslator: TranslatorFunction = (
          text,
          config,
          from,
          to,
          options,
        ) =>
          translator(text, config, from, to, {
            ...options,
            beforeRequest: async () => {
              // The outer slot already scheduled the first request. SDK-level
              // format/thinking retries must reserve subsequent start times.
              if (!firstRequest) {
                await acquire(
                  `provider-fallback:${provider.id}`,
                  resolveRateLimitConfig(provider),
                  this.signal,
                );
              }
              firstRequest = false;
              throwIfSignalCancelled(this.signal);
              await options?.beforeRequest?.();
            },
          });
        const result = await operation(provider, scheduledTranslator);
        this.activeIndex = Math.max(this.activeIndex, index);
        return result;
      } catch (error) {
        if (error instanceof ProviderFallbackExhaustedError) throw error;
        if (isTaskCancelledError(error)) throw error;
        throwIfSignalCancelled(this.signal);
        if (!isFallbackEligibleError(error)) throw error;

        lastError = error;
        const shouldNotify = !this.failed.has(provider.id);
        this.failed.add(provider.id);
        const nextIndex = this.findNextAvailable(index + 1);
        if (nextIndex === -1) {
          this.exhaustedError ??= new ProviderFallbackExhaustedError(
            this.candidates,
            error,
          );
          throw this.exhaustedError;
        }

        const nextProvider = this.candidates[nextIndex];
        this.activeIndex = nextIndex;
        const reason = sanitizeFallbackReason(
          error instanceof Error ? error.message : String(error),
          this.candidates,
        );
        if (shouldNotify) {
          this.log(
            `翻译服务「${provider.name || provider.id}」失败，切换到「${nextProvider.name || nextProvider.id}」: ${reason}`,
            'warning',
          );
          this.onFallback?.({ from: provider, to: nextProvider, reason });
        }
        index = nextIndex;
      } finally {
        release();
      }
    }

    this.exhaustedError ??= new ProviderFallbackExhaustedError(
      this.candidates,
      lastError,
    );
    throw this.exhaustedError;
  }

  private findNextAvailable(start: number): number {
    for (let index = start; index < this.candidates.length; index += 1) {
      if (!this.failed.has(this.candidates[index].id)) return index;
    }
    return -1;
  }
}

import type { TranslationRequestOptions } from '../translate/types';

/**
 * 把调用方的请求选项转成 OpenAI SDK 的单次请求选项（OpenAI / Azure OpenAI 共用）。
 *
 * SDK 默认每次尝试最多等 10 分钟，并把超时再重发两次：一个卡住的请求能占住
 * 调用方 30 分钟（#507）。调用方用 timeoutMs / maxRetries 收紧；未设置、或值
 * 没有意义时保持 SDK 默认，既有调用路径的行为不变。
 */
export function toSdkRequestOptions(options?: TranslationRequestOptions): {
  signal: AbortSignal | undefined;
  timeout?: number;
  maxRetries?: number;
} {
  const timeout = options?.timeoutMs;
  const maxRetries = options?.maxRetries;
  return {
    signal: options?.signal,
    ...(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? { timeout }
      : {}),
    ...(typeof maxRetries === 'number' &&
    Number.isInteger(maxRetries) &&
    maxRetries >= 0
      ? { maxRetries }
      : {}),
  };
}

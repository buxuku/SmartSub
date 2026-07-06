/**
 * 结构化输出（response_format）统一回退链。
 *
 * 不同 AI 服务对 response_format 的支持不一，运行时按
 * json_schema → json_object → disabled 逐级静默降级。
 * 降级判定逻辑源自 @nightt5879 的 PR #328（修复 issue #326），
 * 原先分散在 openai.ts / ollama.ts 各自实现，此处收敛为共用执行器。
 * Credit & sincere thanks to @nightt5879.
 *
 * 严格模式（provider.strictStructuredOutput）：
 * 服务商测试面板的「自动探测」需要知道每种模式的真实成败，
 * 此时禁用静默降级，失败直接抛出，由渲染层逐模式重试并把探测结果写回配置。
 * 正式翻译链路不传该字段，运行时降级行为不变。
 */

import {
  STRUCTURED_OUTPUT_MODES,
  StructuredOutputMode,
} from '../../types/provider';
import { isTaskCancelledError } from '../helpers/taskContext';

export { STRUCTURED_OUTPUT_MODES };
export type { StructuredOutputMode };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 判断错误是否为「服务不支持结构化输出（response_format）」，
 * 用于在第三方 OpenAI 兼容服务拒绝结构化输出时自动降级重试。
 */
export function isStructuredOutputUnsupportedError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  const mentionsStructuredOutput =
    message.includes('response_format') ||
    message.includes('json_schema') ||
    message.includes('json_object') ||
    message.includes('structured output');

  if (!mentionsStructuredOutput) {
    return false;
  }

  return [
    'unsupported',
    'not support',
    'invalid',
    'unrecognized',
    'unknown',
    'not allowed',
    'extra_forbidden',
    '不支持',
    '无效',
    '未知',
    '不允许',
  ].some((keyword) => message.includes(keyword));
}

/**
 * 解析生效的结构化输出模式：
 * structuredOutput（合法值）优先，其次兼容旧 useJsonMode 开关，最后落到调用方默认值。
 */
export function resolveStructuredOutputMode(
  provider: {
    structuredOutput?: string;
    useJsonMode?: boolean;
  },
  defaultMode: StructuredOutputMode = 'json_object',
): StructuredOutputMode {
  if (
    provider.structuredOutput &&
    (STRUCTURED_OUTPUT_MODES as string[]).includes(provider.structuredOutput)
  ) {
    return provider.structuredOutput as StructuredOutputMode;
  }
  if (provider.useJsonMode === false) return 'disabled';
  return defaultMode;
}

export interface StructuredOutputFallbackOptions<T> {
  /** 起始模式，回退链为 STRUCTURED_OUTPUT_MODES 中它之后的部分 */
  startMode: StructuredOutputMode;
  /** 严格模式：不降级，首个错误直接抛出（测试自动探测用） */
  strict?: boolean;
  /** 取消信号：已取消的请求不参与降级 */
  signal?: AbortSignal;
  /** 按指定模式执行一次请求 */
  attempt: (mode: StructuredOutputMode) => Promise<T>;
  /** 某模式失败后是否值得降级到下一模式重试 */
  shouldFallback: (from: StructuredOutputMode, error: unknown) => boolean;
  /** 降级时的通知（打日志用） */
  onFallback?: (
    from: StructuredOutputMode,
    to: StructuredOutputMode,
    error: unknown,
  ) => void;
}

/**
 * 按回退链执行请求：从 startMode 起依次尝试更宽松的模式，
 * 全部失败或不满足降级条件时抛出当前错误。
 */
export async function runWithStructuredOutputFallback<T>(
  options: StructuredOutputFallbackOptions<T>,
): Promise<T> {
  const { startMode, strict, signal, attempt, shouldFallback, onFallback } =
    options;
  const startIndex = STRUCTURED_OUTPUT_MODES.indexOf(startMode);
  const chain =
    startIndex >= 0 ? STRUCTURED_OUTPUT_MODES.slice(startIndex) : [startMode];

  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    const mode = chain[i];
    try {
      return await attempt(mode);
    } catch (error) {
      lastError = error;
      const next = chain[i + 1];
      if (
        strict ||
        !next ||
        signal?.aborted ||
        isTaskCancelledError(error) ||
        !shouldFallback(mode, error)
      ) {
        throw error;
      }
      onFallback?.(mode, next, error);
    }
  }
  throw lastError;
}

/**
 * 检查是否是配置相关的错误
 * 配置错误应该直接中止任务，不进行重试
 */
export function isConfigurationError(error: Error): boolean {
  const errorMessage = error.message.toLowerCase();

  // 明确的配置错误模式
  const explicitConfigErrors = [
    'missingkeyorsecret',
    'api key is required',
    'openai api key is required',
    'not supported language',
    'missing api key',
    'invalid api key',
    'api key not valid',
    'invalid credentials',
    'configuration error',
    'missing configuration',
    '请先配置',
  ];

  // 认证相关错误模式
  const authErrors = [
    'unauthorized',
    'authentication failed',
    'access denied',
    'forbidden',
    '401',
    '403',
  ];

  // 检查是否包含明确的配置错误
  const hasExplicitConfigError = explicitConfigErrors.some((pattern) =>
    errorMessage.includes(pattern),
  );

  // 检查是否是认证错误（但排除网络相关的认证问题）
  const hasAuthError =
    authErrors.some((pattern) => errorMessage.includes(pattern)) &&
    !errorMessage.includes('network') &&
    !errorMessage.includes('timeout');

  // 检查原始错误消息中的配置错误模式（保持大小写敏感）
  const hasOriginalConfigError = [
    'missingKeyOrSecret',
    'OpenAI API key is required',
    'not supported language',
    'API key not valid',
  ].some((pattern) => error.message.includes(pattern));

  return hasExplicitConfigError || hasAuthError || hasOriginalConfigError;
}

/**
 * 判断是否值得切换到同 type 的备用实例。
 *
 * 认证、额度、限流和临时网络错误通常只说明当前实例不可用；语言、模型、
 * 请求格式等错误换 key 也无法修复，必须保留原错误直接反馈给用户。
 */
export function isFallbackEligibleError(error: unknown): boolean {
  const raw = (error instanceof Error ? error.message : String(error ?? ''))
    .toLowerCase()
    .trim();
  if (!raw) return false;

  const explicitNonFallbackErrors = [
    'aborted',
    'aborterror',
    'cancelled',
    'canceled',
    'task cancelled',
    'not supported language',
    'unsupported language',
    'language not supported',
    'missing configuration',
    'configuration error',
    'api key is required',
    'missing api key',
    'missingkeyorsecret',
    'invalid model',
    'model not found',
    'invalid request',
    'bad request',
    'response_format',
    'structured output',
    'invalid parameter',
    'unsupported parameter',
    'parameter error',
  ];
  if (explicitNonFallbackErrors.some((pattern) => raw.includes(pattern))) {
    return false;
  }

  const statusValue = Number(
    (error as any)?.status ??
      (error as any)?.statusCode ??
      (error as any)?.response?.status,
  );
  const statusMatch = raw.match(
    /(?:^|:\s*|http\s*(?:status\s*)?|status(?:\s+code)?\s*)(4\d\d|5\d\d)\b/,
  );
  const status =
    Number.isFinite(statusValue) && statusValue > 0
      ? statusValue
      : statusMatch
        ? Number(statusMatch[1])
        : 0;
  if (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  ) {
    return true;
  }

  return [
    'unauthorized',
    'forbidden',
    'access denied',
    'authentication failed',
    'auth failed',
    'invalid credentials',
    'invalid api key',
    'incorrect api key',
    'api key not valid',
    'quota',
    'rate limit',
    'ratelimit',
    'too many requests',
    'insufficient balance',
    'insufficient_quota',
    'insufficient quota',
    'billing hard limit',
    'credit balance',
    'econnreset',
    'econnrefused',
    'enotfound',
    'eai_again',
    'etimedout',
    'timeout',
    'timed out',
    'connection error',
    'fetch failed',
    'network error',
    'socket hang up',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'network connection failed',
    'limit exceeded',
    'requestlimit',
    'throttling',
    'account overdue',
    '网络连接失败',
    '网络错误',
    '鉴权失败',
    '访问被拒绝',
    '权限不足',
    '请求超时',
    '服务不可用',
    '请求过于频繁',
    '频率限制',
    '余额不足',
    '额度不足',
    '配额不足',
  ].some((pattern) => raw.includes(pattern));
}

/** 批量翻译失败时写入 targetContent 的前缀 */
const TRANSLATION_FAILURE_PREFIX = '[翻译失败:';

export function extractTranslationFailure(
  text: string | undefined | null,
): string | null {
  if (!text || !text.trim()) return 'empty translation result';
  const trimmed = text.trim();
  if (!trimmed.startsWith(TRANSLATION_FAILURE_PREFIX)) return null;
  const inner = trimmed
    .slice(TRANSLATION_FAILURE_PREFIX.length)
    .replace(/\]\s*$/, '')
    .trim();
  return inner || trimmed;
}

export function assertValidTestTranslation(translation: string): void {
  const failure = extractTranslationFailure(translation);
  if (failure) {
    throw new Error(failure);
  }
}

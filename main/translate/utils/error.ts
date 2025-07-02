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
  ].some((pattern) => error.message.includes(pattern));

  return hasExplicitConfigError || hasAuthError || hasOriginalConfigError;
}

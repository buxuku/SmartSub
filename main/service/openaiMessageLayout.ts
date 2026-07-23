export type OpenAIMessageLayout = 'auto' | 'system_user' | 'single_user';

export type OpenAIRequestMessage = {
  role: 'system' | 'user';
  content: string;
};

/**
 * Qwen-MT 的 OpenAI 兼容接口只接受一条 user 消息，不支持 system 消息。
 * 自动模式仅匹配明确的 qwen-mt 型号，避免改变普通 Qwen/DeepSeek/OpenAI 模型。
 */
export function requiresSingleUserMessage(modelName?: string): boolean {
  const normalized = String(modelName || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  return normalized === 'qwen-mt' || normalized.includes('qwen-mt-');
}

export function resolveOpenAIMessageLayout(
  layout: OpenAIMessageLayout | string | undefined,
  modelName?: string,
): Exclude<OpenAIMessageLayout, 'auto'> {
  if (layout === 'system_user' || layout === 'single_user') {
    return layout;
  }
  return requiresSingleUserMessage(modelName) ? 'single_user' : 'system_user';
}

/**
 * 构造 OpenAI Chat Completions 的消息数组。
 *
 * single_user 会把系统提示词与本次用户内容合并为唯一一条 user 消息，
 * 兼容 Qwen-MT 等不接受 system 消息或多消息输入的翻译专用模型。
 */
export function buildOpenAIRequestMessages(
  systemPrompt: string,
  userPrompt: string,
  layout: OpenAIMessageLayout | string | undefined,
  modelName?: string,
): OpenAIRequestMessage[] {
  const resolved = resolveOpenAIMessageLayout(layout, modelName);
  if (resolved === 'single_user') {
    return [
      {
        role: 'user',
        content: `${systemPrompt}\n\n${userPrompt}`,
      },
    ];
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

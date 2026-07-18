export const AI_RETRY_FORMAT_INSTRUCTION =
  '上一次响应无法解析。请只返回一个 JSON 对象，键必须是输入字幕 ID，值必须是翻译结果；不要返回 markdown、解释、注释或思考过程。';

export const AI_ECHO_RETRY_FORMAT_INSTRUCTION =
  '上一次响应存在错位或无法解析。请只返回一个 JSON 对象：键必须与输入字幕 ID 完全一致，每个键的值是 {"src": ..., "tr": ...}。注意：src 必须逐字复制输入中该 ID 对应的原文（保持原语言，绝对不能填译文），tr 才是译文；禁止合并或拆分条目，不要返回 markdown、解释或思考过程。';

interface AITranslationPromptAttemptOptions {
  isRetry: boolean;
  echoEnabled: boolean;
  appendRetryPrompt?: boolean;
}

export function buildAITranslationPromptForAttempt(
  basePrompt: string,
  options: AITranslationPromptAttemptOptions,
): string {
  if (!options.isRetry || options.appendRetryPrompt === false) {
    return basePrompt;
  }

  const instruction = options.echoEnabled
    ? AI_ECHO_RETRY_FORMAT_INSTRUCTION
    : AI_RETRY_FORMAT_INSTRUCTION;
  return `${basePrompt}\n\n${instruction}`;
}

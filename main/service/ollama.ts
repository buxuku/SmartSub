import axios from 'axios';
import { TRANSLATION_JSON_SCHEMA } from '../translate/constants/schema';

interface OllamaConfig {
  apiUrl: string;
  modelName: string;
  prompt: string;
  systemPrompt: string;
  useJsonMode?: boolean;
}

export default async function translateWithOllama(
  text: string,
  config: OllamaConfig,
) {
  const { apiUrl, modelName, systemPrompt, useJsonMode } = config;
  const url = apiUrl.replace('generate', 'chat'); // 兼容旧版本的ollama

  try {
    // 为JSON模式增强system prompt
    let enhancedSystemPrompt = systemPrompt;

    // 如果开启了JSON模式，添加JSON格式说明
    if (useJsonMode !== false) {
      enhancedSystemPrompt = `${systemPrompt}\n\n你必须以JSON格式返回数据，不要包含任何其他文本或说明。输出应该是一个有效的JSON对象，其中键是字幕ID，值是翻译后的内容。\n\n下面是返回的JSON Schema:\n${JSON.stringify(TRANSLATION_JSON_SCHEMA, null, 2)}`;
    }

    const response = await axios.post(`${url}`, {
      model: modelName,
      messages: [
        { role: 'system', content: enhancedSystemPrompt },
        { role: 'user', content: text },
      ],
      stream: false,
      format: 'json',
    });

    if (response.data && response.data.message) {
      return response.data.message?.content?.trim();
    } else {
      throw new Error(
        response?.data?.error || 'Unexpected response from Ollama',
      );
    }
  } catch (error) {
    throw error;
  }
}

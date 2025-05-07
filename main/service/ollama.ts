import axios from 'axios';

interface OllamaConfig {
  apiUrl: string;
  modelName: string;
  prompt: string;
  systemPrompt: string;
}

export default async function translateWithOllama(
  text: string,
  config: OllamaConfig,
) {
  const { apiUrl, modelName, systemPrompt } = config;
  const url = apiUrl.replace('generate', 'chat'); // 兼容旧版本的ollama
  try {
    const response = await axios.post(`${url}`, {
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      stream: false,
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

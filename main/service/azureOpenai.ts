import { AzureOpenAI } from 'openai';

type AzureOpenAIProvider = {
  apiUrl: string;
  apiKey: string;
  modelName?: string;
  prompt?: string;
  systemPrompt?: string;
};

export async function translateWithAzureOpenAI(
  text: string[],
  provider: AzureOpenAIProvider,
) {
  try {
    // 处理Azure OpenAI的endpoint URL
    const url = new URL(provider.apiUrl);
    const pathParts = url.pathname.split('/');
    const deploymentName = pathParts[pathParts.indexOf('deployments') + 1];
    const apiVersion = url.searchParams.get('api-version') || '2023-05-15';
    const baseURL = `${url.protocol}//${url.host}/`;

    const openai = new AzureOpenAI({
      endpoint: baseURL,
      apiKey: provider.apiKey,
      deployment: deploymentName,
      apiVersion: apiVersion,
    });

    const sysPrompt =
      provider.systemPrompt ||
      'You are a professional subtitle translation tool';
    const userPrompt = Array.isArray(text) ? text.join('\n') : text;

    const completion = await openai.chat.completions.create({
      model: undefined,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    });

    const result = completion?.choices?.[0]?.message?.content?.trim();

    return result;
  } catch (error) {
    console.error('Azure OpenAI translation error:', error);
    throw new Error(`Azure OpenAI translation failed: ${error.message}`);
  }
}

export default translateWithAzureOpenAI;

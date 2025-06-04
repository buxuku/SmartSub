import { translateWithOpenAI } from './openai';

// OpenAI API 示例
export const openaiProvider = {
  apiUrl: 'https://api.openai.com/v1',
  apiKey: 'your-openai-api-key',
  modelName: 'gpt-4',
  systemPrompt:
    'You are a professional subtitle translation tool. Translate the following subtitles to Chinese.',
  useJsonMode: true,
  providerType: 'openai' as const,
};

// Gemini API 示例
export const geminiProvider = {
  apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey: 'your-gemini-api-key',
  modelName: 'gemini-2.0-flash',
  systemPrompt:
    'You are a professional subtitle translation tool. Translate the following subtitles to Chinese.',
  useJsonMode: true,
  providerType: 'gemini' as const,
};

// 其他OpenAI兼容API示例 (如Claude via API Gateway等)
export const genericProvider = {
  apiUrl: 'https://your-api-gateway.com/v1',
  apiKey: 'your-api-key',
  modelName: 'claude-3-sonnet',
  systemPrompt:
    'You are a professional subtitle translation tool. Translate the following subtitles to Chinese.',
  useJsonMode: true,
  providerType: 'generic' as const,
};

// 使用示例
export async function exampleUsage() {
  const subtitles = [
    '1: Hello world!',
    '2: How are you today?',
    '3: This is a test subtitle.',
  ];

  try {
    // 使用OpenAI
    console.log('Testing OpenAI...');
    const openaiResult = await translateWithOpenAI(subtitles, openaiProvider);
    console.log('OpenAI Result:', openaiResult);

    // 使用Gemini
    console.log('Testing Gemini...');
    const geminiResult = await translateWithOpenAI(subtitles, geminiProvider);
    console.log('Gemini Result:', geminiResult);

    // 使用通用API
    console.log('Testing Generic API...');
    const genericResult = await translateWithOpenAI(subtitles, genericProvider);
    console.log('Generic Result:', genericResult);
  } catch (error) {
    console.error('Translation failed:', error);
  }
}

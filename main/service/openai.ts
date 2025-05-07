import OpenAI from 'openai';

type OpenAIProvider = {
  apiUrl: string;
  apiKey: string;
  modelName?: string;
  prompt?: string;
  systemPrompt?: string;
};

export async function translateWithOpenAI(
  text: string[],
  provider: OpenAIProvider,
) {
  try {
    const openai = new OpenAI({
      baseURL: provider.apiUrl,
      apiKey: provider.apiKey,
    });

    const sysPrompt =
      provider.systemPrompt ||
      'You are a professional subtitle translation tool';
    const userPrompt = Array.isArray(text) ? text.join('\n') : text;
    console.log('sysPrompt:', sysPrompt);
    console.log('userPrompt:', userPrompt);
    const completion = await openai.chat.completions.create({
      model: provider.modelName || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    });
    console.log('completion:', completion);
    const result = completion?.choices?.[0]?.message?.content?.trim();

    return result;
  } catch (error) {
    console.error('OpenAI translation error:', error);
    throw new Error(`OpenAI translation failed: ${error.message}`);
  }
}

export default translateWithOpenAI;

import { AzureOpenAI } from 'openai';
import { TRANSLATION_JSON_SCHEMA } from '../translate/constants/schema';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';
import {
  isStructuredOutputUnsupportedError,
  resolveStructuredOutputMode,
  runWithStructuredOutputFallback,
  type StructuredOutputMode,
} from './structuredOutputFallback';

type AzureOpenAIProvider = {
  apiUrl: string;
  apiKey: string;
  modelName?: string;
  prompt?: string;
  systemPrompt?: string;
  useJsonMode?: boolean;
  structuredOutput?: StructuredOutputMode;
  strictStructuredOutput?: boolean;
};

/** 老 api-version 不支持 response_format，任何结构化模式都退化为普通输出 */
function buildResponseFormat(
  mode: StructuredOutputMode,
  apiVersion: string,
): Record<string, any> | undefined {
  if (parseFloat(apiVersion) < 2023.12) return undefined;
  if (mode === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'subtitle_translation',
        schema: TRANSLATION_JSON_SCHEMA,
      },
    };
  }
  if (mode === 'json_object') {
    return { type: 'json_object' };
  }
  return undefined;
}

export async function translateWithAzureOpenAI(
  text: string | string[],
  provider: AzureOpenAIProvider,
  _sourceLanguage?: string,
  _targetLanguage?: string,
  options?: TranslationRequestOptions,
) {
  try {
    throwIfSignalCancelled(options?.signal);
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

    const baseParams: any = {
      model: undefined,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    };

    // 结构化输出走共享回退链（json_schema → json_object → disabled）
    const completion = await runWithStructuredOutputFallback({
      startMode: resolveStructuredOutputMode(provider, 'json_schema'),
      strict: provider.strictStructuredOutput === true,
      signal: options?.signal,
      shouldFallback: (from, error) =>
        from === 'json_schema' || isStructuredOutputUnsupportedError(error),
      onFallback: (from, to, error) =>
        console.warn(
          `Azure OpenAI structured output ${from} failed, falling back to ${to}:`,
          error,
        ),
      attempt: (mode) => {
        const responseFormat = buildResponseFormat(mode, apiVersion);
        const requestParams = responseFormat
          ? { ...baseParams, response_format: responseFormat }
          : baseParams;
        return openai.chat.completions.create(requestParams, {
          signal: options?.signal,
        });
      },
    });
    throwIfSignalCancelled(options?.signal);

    const result = completion?.choices?.[0]?.message?.content?.trim();

    return result;
  } catch (error) {
    if (options?.signal?.aborted) throw new TaskCancelledError();
    console.error('Azure OpenAI translation error:', error);
    throw new Error(`Azure OpenAI translation failed: ${error.message}`);
  }
}

export default translateWithAzureOpenAI;

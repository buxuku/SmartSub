import http from 'http';
import https from 'https';
import OpenAI from 'openai';
import { modelRequestMessages } from './messageContent';
import type { Provider } from '../../types/provider';
import { isProviderConfigured } from '../../types/provider';
import { ASSISTANT_PROVIDER_TYPES } from '../../types/assistant';
import { normalizeOpenAIBaseURL } from '../service/openai';
import { ParameterProcessor } from '../helpers/parameterProcessor';
import {
  resolveThinkingParams,
  runWithThinkingParamFallback,
} from '../service/thinkingControl';
import { collectReply, type ModelMessage } from './protocol';

export function supportsAssistant(provider: Provider) {
  return (
    ASSISTANT_PROVIDER_TYPES.has(provider.type) &&
    isProviderConfigured(provider) &&
    !!provider.modelName
  );
}

export async function requestAssistant(
  provider: Provider,
  messages: ModelMessage[],
  tools: any[],
  signal: AbortSignal,
  onText: (text: string) => void,
) {
  const requestMessages = await modelRequestMessages(messages);
  const baseURL = normalizeOpenAIBaseURL(provider.apiUrl);
  const custom = ParameterProcessor.processCustomParameters(provider, {});
  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL,
    maxRetries: 0,
    timeout: 120000,
    httpAgent: baseURL.startsWith('https:')
      ? https.globalAgent
      : http.globalAgent,
    defaultHeaders: Object.fromEntries(
      Object.entries(custom.headers).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
  });
  // Translation-only or protocol-shaping parameters cannot replace the runtime's messages/tools.
  const params = { ...custom.body };
  for (const key of [
    'messages',
    'model',
    'stream',
    'tools',
    'tool_choice',
    'response_format',
    'n',
    'functions',
    'function_call',
    'parallel_tool_calls',
  ])
    delete params[key];
  const stream = await runWithThinkingParamFallback({
    provider,
    signal,
    attempt: () =>
      client.chat.completions.create(
        {
          ...resolveThinkingParams(provider),
          ...params,
          model: provider.modelName,
          messages: requestMessages as any,
          tools,
          tool_choice: 'auto',
          stream: true,
        },
        { signal },
      ),
  });
  return collectReply(stream, signal, onText);
}

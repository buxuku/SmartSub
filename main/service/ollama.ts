import axios from 'axios';
import { TRANSLATION_JSON_SCHEMA } from '../translate/constants/schema';
import { OLLAMA_REQUEST_TIMEOUT } from '../translate/constants';
import {
  TaskCancelledError,
  throwIfSignalCancelled,
} from '../helpers/taskContext';
import type { TranslationRequestOptions } from '../translate/types';
import {
  resolveStructuredOutputMode,
  runWithStructuredOutputFallback,
  type StructuredOutputMode,
} from './structuredOutputFallback';

interface OllamaConfig {
  apiUrl: string;
  modelName: string;
  prompt: string;
  systemPrompt: string;
  useJsonMode?: boolean;
  structuredOutput?: StructuredOutputMode;
  strictStructuredOutput?: boolean;
}

function getOllamaFormat(
  mode: StructuredOutputMode,
  responseJsonSchema?: Record<string, unknown>,
) {
  // 优先使用按批次动态生成的 schema（锁死键集合，design D1/D2），
  // 未传时回退到静态 schema 保持旧行为。
  if (mode === 'json_schema')
    return responseJsonSchema ?? TRANSLATION_JSON_SCHEMA;
  if (mode === 'json_object') return 'json';
  return undefined;
}

function getErrorMessage(error: any): string {
  return String(
    error?.response?.data?.error ||
      error?.response?.data?.message ||
      error?.message ||
      error,
  );
}

function isSchemaFormatUnsupportedError(error: any): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('format') &&
    (message.includes('schema') ||
      message.includes('unmarshal') ||
      message.includes('unsupported') ||
      message.includes('not support') ||
      message.includes('invalid'))
  );
}

export default async function translateWithOllama(
  text: string | string[],
  config: OllamaConfig,
  _sourceLanguage?: string,
  _targetLanguage?: string,
  options?: TranslationRequestOptions,
) {
  const { apiUrl, modelName, systemPrompt } = config;
  const url = apiUrl.replace('generate', 'chat'); // 兼容旧版本的ollama
  const structuredOutputMode = resolveStructuredOutputMode(
    config,
    'json_object',
  );
  const userPrompt = Array.isArray(text) ? text.join('\n') : text;

  try {
    throwIfSignalCancelled(options?.signal);
    // 为JSON模式增强system prompt
    let enhancedSystemPrompt = systemPrompt;

    // 如果开启了JSON模式，添加JSON格式说明
    if (structuredOutputMode !== 'disabled') {
      if (options?.responseJsonSchema) {
        // 动态批次 schema 体积随批量线性增长（45 条 echo schema ≈ 3900 tokens），
        // 全文内嵌会挤爆上下文窗口、把字幕原文截断（实测回显崩坏 44/45）。
        // 结构约束交给 format 参数，提示词只留一句说明。
        enhancedSystemPrompt = `${systemPrompt}\n\n你必须以JSON格式返回数据，不要包含任何其他文本、解释或思考过程。`;
      } else {
        // 未传动态 schema 的调用方（如校对）沿用静态 schema 全文内嵌（体积很小）
        enhancedSystemPrompt = `${systemPrompt}\n\n你必须以JSON格式返回数据，不要包含任何其他文本或说明。输出应该是一个有效的JSON对象，其中键是字幕ID，值是翻译后的内容。\n\n下面是返回的JSON Schema:\n${JSON.stringify(TRANSLATION_JSON_SCHEMA, null, 2)}`;
      }
    }

    const requestBody: Record<string, any> = {
      model: modelName,
      messages: [
        { role: 'system', content: enhancedSystemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      // 与 openai.ts 的 temperature 0.3 对齐：翻译任务低温更稳。
      // num_ctx：ollama 默认上下文窗口偏小（2048/4096），批量翻译输入+回显输出
      // 极易超窗导致原文被截断、回显崩坏（实测 45 条批次 44/45 错位），显式放宽。
      options: { temperature: 0.3, num_ctx: 8192 },
    };

    const postOllama = (body: Record<string, any>) =>
      axios.post(`${url}`, body, {
        timeout: OLLAMA_REQUEST_TIMEOUT,
        signal: options?.signal,
      });

    // 按共享回退链降级：仅当 Ollama 明确报 format 不支持时才降级
    const response = await runWithStructuredOutputFallback({
      startMode: structuredOutputMode,
      strict: config.strictStructuredOutput === true,
      signal: options?.signal,
      shouldFallback: (_from, error) => isSchemaFormatUnsupportedError(error),
      attempt: (mode) => {
        const format = getOllamaFormat(mode, options?.responseJsonSchema);
        return postOllama(format ? { ...requestBody, format } : requestBody);
      },
    });

    if (response.data && response.data.message) {
      throwIfSignalCancelled(options?.signal);
      return response.data.message?.content?.trim();
    } else {
      throw new Error(
        response?.data?.error || 'Unexpected response from Ollama',
      );
    }
  } catch (error) {
    if (options?.signal?.aborted) throw new TaskCancelledError();
    throw error;
  }
}

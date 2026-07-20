import type { ResolvedGlossaryEntry } from '../../../types/glossary';

export interface Subtitle {
  id: string;
  startEndTime: string;
  content: string[];
}

export interface TranslationResult {
  id: string;
  startEndTime: string;
  sourceContent: string;
  targetContent: string;
}

export interface TranslationConfig {
  sourceLanguage: string;
  targetLanguage: string;
  provider: Provider;
  translator: TranslatorFunction;
  glossaryEntries?: ResolvedGlossaryEntry[];
  signal?: AbortSignal;
  /** 测试面板注入的思考元数据收集器（openspec: ai-thinking-mode-control D7） */
  onResponseMeta?: (meta: TranslationResponseMeta) => void;
}

export type TranslatorFunction = (
  text: string | string[],
  config: any,
  from: string,
  to: string,
  options?: TranslationRequestOptions,
) => Promise<string | string[]>;

/**
 * 翻译响应的思考元数据（openspec: ai-thinking-mode-control D7）。
 * 服务层拿到原始响应后通过 onResponseMeta 回传，测试面板据此展示思考状态徽标。
 */
export interface TranslationResponseMeta {
  /** 独立思考字段（reasoning_content / ollama message.thinking）是否非空 */
  reasoningContentPresent?: boolean;
  /** usage.completion_tokens_details.reasoning_tokens */
  reasoningTokens?: number;
  completionTokens?: number;
  /** 思考内联进 content 的情况（<think> 标签），同样视为思考发生 */
  contentThinkTagPresent?: boolean;
}

export interface TranslationRequestOptions {
  signal?: AbortSignal;
  /**
   * 按批次动态生成的响应 JSON Schema（design D1）。
   * 提供时 service 层在 json_schema 模式下优先使用它（锁死批次键集合）；
   * 未提供时沿用各 service 的静态 schema 行为（向后兼容）。
   */
  responseJsonSchema?: Record<string, unknown>;
  /**
   * 响应元数据回调（openspec: ai-thinking-mode-control D7）：
   * 正式翻译链路不传（零开销），测试面板传入收集器判定思考是否实际发生。
   */
  onResponseMeta?: (meta: TranslationResponseMeta) => void;
}

export interface Provider {
  type: string;
  id: string;
  name: string;
  isAi: boolean;
  prompt?: string;
  systemPrompt?: string;
  useBatchTranslation?: boolean;
  batchSize?: number;
  batchConcurrency?: number;
  [key: string]: any;
}

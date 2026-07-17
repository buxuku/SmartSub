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
}

export type TranslatorFunction = (
  text: string | string[],
  config: any,
  from: string,
  to: string,
  options?: TranslationRequestOptions,
) => Promise<string | string[]>;

export interface TranslationRequestOptions {
  signal?: AbortSignal;
  /**
   * 按批次动态生成的响应 JSON Schema（design D1）。
   * 提供时 service 层在 json_schema 模式下优先使用它（锁死批次键集合）；
   * 未提供时沿用各 service 的静态 schema 行为（向后兼容）。
   */
  responseJsonSchema?: Record<string, unknown>;
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

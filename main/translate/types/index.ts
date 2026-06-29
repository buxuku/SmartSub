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

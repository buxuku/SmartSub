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
}

export type TranslatorFunction = (
  text: string[],
  config: any,
  from: string,
  to: string,
) => Promise<string>;

export interface Provider {
  type: string;
  id: string;
  name: string;
  isAi: boolean;
  prompt?: string;
  systemPrompt?: string;
  useBatchTranslation?: boolean;
  batchSize?: number;
  [key: string]: any;
}

// 定义翻译结果的JSON Schema
export const TRANSLATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'string',
    description: '字幕翻译结果',
  },
  description: '字幕翻译结果，键为字幕ID，值为翻译后的内容',
};

// 类型定义
export type TranslationJsonResult = Record<string, string>;

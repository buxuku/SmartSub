import { z } from 'zod';

// 定义翻译结果的JSON Schema
export const TRANSLATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'string',
    description: '字幕翻译结果',
  },
  description: '字幕翻译结果，键为字幕ID，值为翻译后的内容',
};

// Zod schema for translation results - compatible with Gemini
export const TranslationResultSchema = z
  .record(z.string(), z.string())
  .describe('字幕翻译结果，键为字幕ID，值为翻译后的内容');

// 类型定义
export type TranslationJsonResult = Record<string, string>;

/** 批次 schema 的属性数上限：规避 Gemini 等渠道对大 schema 的复杂度限制（design D8）。 */
export const BATCH_SCHEMA_MAX_PROPERTIES = 100;

/**
 * 按批次动态生成 JSON Schema：每个字幕 ID 一个 required 属性 +
 * additionalProperties:false，使支持 json_schema 的渠道在解码层面锁死条数。
 *
 * echo=true 时值为 {src, tr} 回显结构（src 回显原文用于对齐校验，design D2/D4）；
 * echo=false 时值为纯字符串译文。
 */
export function makeBatchSchema(
  ids: string[],
  options?: { echo?: boolean },
): Record<string, unknown> {
  const echo = options?.echo !== false;
  const valueSchema = echo
    ? {
        type: 'object',
        properties: {
          src: {
            type: 'string',
            // 小模型偶发把译文填进 src（实测案例），description 强调保持原语言
            description:
              '逐字复制该条字幕的原文，保持输入的原语言，禁止填写译文',
          },
          tr: { type: 'string', description: '该条字幕的译文' },
        },
        required: ['src', 'tr'],
        additionalProperties: false,
      }
    : { type: 'string', description: '该条字幕的译文' };

  return {
    type: 'object',
    properties: Object.fromEntries(ids.map((id) => [id, valueSchema])),
    required: [...ids],
    additionalProperties: false,
  };
}

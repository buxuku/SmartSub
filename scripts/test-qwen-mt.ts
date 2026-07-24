/// <reference path="./test-globals.d.ts" />

import axios from 'axios';
import {
  buildQwenMtRequestBody,
  resolveQwenMtApiUrl,
  resolveQwenMtLanguage,
} from '../main/service/qwenMt';
import qwenMtTranslator from '../main/service/qwenMt';
import type { ResolvedGlossaryEntry } from '../types/glossary';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, name: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    passed++;
  } else {
    failed++;
    console.error(
      `✗ ${name}\n    expected: ${expectedJson}\n    actual:   ${actualJson}`,
    );
  }
}

function glossaryEntry(source: string, target: string): ResolvedGlossaryEntry {
  return {
    id: source,
    source,
    target,
    createdAt: 0,
    updatedAt: 0,
    glossaryId: 'test',
    glossaryName: '测试词库',
    glossaryOrder: 0,
    entryOrder: 0,
  };
}

async function run(): Promise<void> {
  eq(
    resolveQwenMtApiUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    'API 地址补全 chat/completions',
  );
  eq(
    resolveQwenMtApiUrl('https://example.com/v1/chat/completions'),
    'https://example.com/v1/chat/completions',
    '完整 API 地址不重复拼接',
  );
  eq(resolveQwenMtLanguage('zh', true), 'Chinese', '简体中文映射');
  eq(
    resolveQwenMtLanguage('zh-Hant', false),
    'Traditional Chinese',
    '繁体中文映射',
  );
  eq(resolveQwenMtLanguage('no', false), 'Norwegian Bokmål', '挪威语映射');
  eq(resolveQwenMtLanguage('auto', true), 'auto', '源语言支持自动检测');
  eq(resolveQwenMtLanguage('auto', false), null, '目标语言不接受自动检测');
  eq(resolveQwenMtLanguage('mn', false), null, '不支持的蒙古语被拒绝');

  eq(
    buildQwenMtRequestBody('你好', 'qwen-mt-flash', 'Chinese', 'English', [
      { source: '妙幕', target: 'SmartSub' },
    ]),
    {
      model: 'qwen-mt-flash',
      messages: [{ role: 'user', content: '你好' }],
      translation_options: {
        source_lang: 'Chinese',
        target_lang: 'English',
        terms: [{ source: '妙幕', target: 'SmartSub' }],
      },
    },
    '请求体仅含单条 user 消息与 translation_options',
  );

  const originalPost = axios.post;
  const calls: Array<{ url: string; body: any; config: any }> = [];
  (axios as any).post = async (url: string, body: any, config: any) => {
    calls.push({ url, body, config });
    return {
      data: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: `译文：${body.messages[0].content}`,
            },
          },
        ],
      },
    };
  };

  try {
    const result = await qwenMtTranslator(
      ['欢迎使用妙幕', '普通字幕'],
      {
        apiKey: 'test-key',
        apiUrl: 'https://example.com/v1',
        modelName: 'qwen-mt-plus',
      },
      'zh',
      'en',
      {
        glossaryEntries: [
          glossaryEntry('妙幕', 'SmartSub'),
          glossaryEntry('未命中', 'unused'),
        ],
      },
    );

    eq(result, ['译文：欢迎使用妙幕', '译文：普通字幕'], '保持数组结果顺序');
    eq(calls.length, 2, '每条字幕发起一个请求');
    eq(
      calls[0].body.messages,
      [{ role: 'user', content: '欢迎使用妙幕' }],
      '请求只有一条 user 消息',
    );
    eq(
      calls[0].body.translation_options,
      {
        source_lang: 'Chinese',
        target_lang: 'English',
        terms: [{ source: '妙幕', target: 'SmartSub' }],
      },
      '仅下发当前字幕命中的原生术语',
    );
    eq(
      calls[1].body.translation_options,
      {
        source_lang: 'Chinese',
        target_lang: 'English',
      },
      '无词条命中时省略 terms',
    );
    eq(
      Object.prototype.hasOwnProperty.call(calls[0].body, 'response_format'),
      false,
      '不发送 response_format',
    );
    eq(
      Object.prototype.hasOwnProperty.call(calls[0].body, 'enable_thinking'),
      false,
      '不发送 enable_thinking',
    );
    eq(
      calls[0].config.headers.Authorization,
      'Bearer test-key',
      '使用 Bearer API Key',
    );

    const requestCountBeforeEmptySubtitles = calls.length;
    const emptyResults = await qwenMtTranslator(
      ['', '   '],
      {
        apiKey: 'test-key',
        apiUrl: 'https://example.com/v1',
        modelName: 'qwen-mt-plus',
      },
      'zh',
      'en',
    );
    eq(emptyResults, ['', '   '], '空白字幕原样返回');
    eq(
      calls.length,
      requestCountBeforeEmptySubtitles,
      '空白字幕不发送 API 请求',
    );
  } finally {
    (axios as any).post = originalPost;
  }

  console.log(`Qwen-MT tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

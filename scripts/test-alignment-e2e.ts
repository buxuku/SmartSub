/// <reference path="./test-globals.d.ts" />
/**
 * AI 翻译对齐管线端到端验证（openspec: ai-translation-alignment task 5.x）。
 *
 * 驱动与 ai.ts 相同的构件链对本地 ollama 实测：
 *   makeBatchSchema → translateWithOllama(responseJsonSchema)
 *   → parseAIAnchoredTranslationResponse → validateAnchoredBatch
 *   → buildRepairRequest 定点补翻
 *
 * 场景：
 *   S1 json_schema + 回显：条数/对齐 100%（gemma2:2b, 91 条, 批 45）
 *   S2 合并滑移检出与修复（deepseek-r1:7b, 批 45，实测高合并率模型）
 *   S3 旧协议自定义提示词（json_object + {id:text}）：降级校验不中断
 *   S4 json_object 降级下回显协议仍工作（提示词驱动，无 schema 约束）
 *
 * 用法：
 *   yarn test:alignment-e2e                 # 仅离线单测（无 ollama 依赖）
 *   E2E=1 yarn test:alignment-e2e           # 全部场景（需本地 ollama）
 *   E2E=1 SKIP_SLOW=1 ...                   # 跳过 deepseek-r1 慢场景
 *   SRT_PATH=/path/to.srt MODEL=gemma2:2b   # 自定义素材与模型
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import translateWithOllama from '../main/service/ollama';
import { makeBatchSchema } from '../main/translate/constants/schema';
import { parseAIAnchoredTranslationResponse } from '../main/translate/utils/aiResponseParser';
import {
  buildRepairRequest,
  validateAnchoredBatch,
} from '../main/translate/utils/alignment';
import type { Subtitle } from '../main/translate/types';
import { defaultSystemPrompt } from '../types/provider';

let passed = 0;
let failed = 0;

function ok(value: unknown, name: string): void {
  if (value) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// ---------------- 离线单测（validateAnchoredBatch / buildRepairRequest） ----------------

function offlineChecks(): void {
  console.log('offline: validateAnchoredBatch');
  const batch: Subtitle[] = [
    {
      id: '1',
      startEndTime: '00:00:01,000 --> 00:00:02,000',
      content: ['Hello world'],
    },
    {
      id: '2',
      startEndTime: '00:00:02,000 --> 00:00:03,000',
      content: ['How are you'],
    },
    {
      id: '3',
      startEndTime: '00:00:03,000 --> 00:00:04,000',
      content: ['Nice to meet you'],
    },
  ];

  // 全部回显匹配
  const good = validateAnchoredBatch(
    {
      '1': { translation: '你好世界', srcEcho: 'Hello world', hasEcho: true },
      '2': { translation: '你好吗', srcEcho: 'How are you', hasEcho: true },
      '3': {
        translation: '很高兴认识你',
        srcEcho: 'Nice to meet you',
        hasEcho: true,
      },
    },
    batch,
    true,
  );
  ok(
    good.flagged.length === 0 && Object.keys(good.accepted).length === 3,
    'all echoes match → no flags',
  );

  // 合并滑移：2 号回显是 1+2 的合并，3 号回显是 2 的内容
  const slipped = validateAnchoredBatch(
    {
      '1': { translation: '你好世界', srcEcho: 'Hello world', hasEcho: true },
      '2': {
        translation: '合并的翻译',
        srcEcho: 'Hello world How are you',
        hasEcho: true,
      },
      '3': { translation: '错位的翻译', srcEcho: 'How are you', hasEcho: true },
    },
    batch,
    true,
  );
  ok(
    slipped.flagged.includes('2') &&
      slipped.flagged.includes('3') &&
      !slipped.flagged.includes('1'),
    'merged/slipped echoes flagged, aligned entry kept',
  );

  // 旧协议纯字符串 → 降级校验（仅空值）
  const legacy = validateAnchoredBatch(
    {
      '1': { translation: '你好世界', hasEcho: false },
      '2': { translation: '', hasEcho: false },
      '3': { translation: '很高兴认识你', hasEcho: false },
    },
    batch,
    true,
  );
  ok(
    legacy.flagged.length === 1 &&
      legacy.flagged[0] === '2' &&
      legacy.echoChecked === 0,
    'legacy strings degrade to empty-value check only',
  );

  // 空原文透传
  const blankBatch: Subtitle[] = [
    { id: '1', startEndTime: '', content: [''] },
    ...batch.slice(1),
  ];
  const blank = validateAnchoredBatch(
    {
      '2': { translation: '你好吗', srcEcho: 'How are you', hasEcho: true },
      '3': {
        translation: '很高兴认识你',
        srcEcho: 'Nice to meet you',
        hasEcho: true,
      },
    },
    blankBatch,
    true,
  );
  ok(!blank.flagged.includes('1'), 'blank source passes through without flag');

  console.log('offline: buildRepairRequest');
  const repair = buildRepairRequest(
    batch[1],
    batch,
    { '1': '你好世界' },
    '简体中文',
  );
  ok(
    repair.prompt.includes('How are you') &&
      repair.prompt.includes('请勿翻译') &&
      repair.prompt.includes('"2"'),
    'repair prompt quotes target line and marks context as reference-only',
  );
  const schema = repair.schema as any;
  ok(
    schema.required.length === 1 &&
      schema.required[0] === '2' &&
      schema.additionalProperties === false,
    'repair schema locks the single key',
  );
}

// ---------------- 在线场景（需本地 ollama） ----------------

function parseSrt(filePath: string): Subtitle[] {
  const text = fs.readFileSync(filePath, 'utf-8');
  const blocks = text.trim().split(/\n\s*\n/);
  const entries: Subtitle[] = [];
  for (const block of blocks) {
    const lines = block
      .trim()
      .split('\n')
      .filter((l) => l.trim());
    if (lines.length >= 3) {
      entries.push({
        id: lines[0].trim(),
        startEndTime: lines[1].trim(),
        content: [lines.slice(2).join(' ').trim()],
      });
    }
  }
  return entries;
}

const OLLAMA_URL = 'http://localhost:11434/api/chat';

interface ScenarioResult {
  aligned: number;
  flagged: number;
  repaired: number;
  unresolved: number;
  echoChecked: number;
}

async function runScenario(params: {
  name: string;
  model: string;
  batch: Subtitle[];
  structuredOutput: 'json_schema' | 'json_object';
  echo: boolean;
  systemPrompt: string;
}): Promise<ScenarioResult> {
  const { model, batch } = params;
  const content = JSON.stringify(
    Object.fromEntries(batch.map((s) => [s.id, s.content.join('\n')])),
    null,
    2,
  );
  const config = {
    apiUrl: OLLAMA_URL,
    modelName: model,
    prompt: '',
    systemPrompt: params.systemPrompt,
    structuredOutput: params.structuredOutput,
  } as any;
  const schema = makeBatchSchema(
    batch.map((s) => s.id),
    { echo: params.echo },
  );

  const response = await translateWithOllama(content, config, 'en', 'zh', {
    ...(params.structuredOutput === 'json_schema'
      ? { responseJsonSchema: schema }
      : {}),
  } as any);

  const parsed = parseAIAnchoredTranslationResponse(String(response ?? ''));
  const validation = validateAnchoredBatch(parsed, batch, params.echo);

  let repaired = 0;
  for (const flaggedId of validation.flagged) {
    const subtitle = batch.find((s) => s.id === flaggedId)!;
    const repairReq = buildRepairRequest(
      subtitle,
      batch,
      validation.accepted,
      '简体中文',
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const repairResponse = await translateWithOllama(
          repairReq.prompt,
          { ...config, structuredOutput: 'json_schema' },
          'en',
          'zh',
          { responseJsonSchema: repairReq.schema } as any,
        );
        const repairParsed = parseAIAnchoredTranslationResponse(
          String(repairResponse ?? ''),
        );
        const translation = repairParsed[flaggedId]?.translation?.trim();
        if (translation) {
          validation.accepted[flaggedId] = translation;
          repaired++;
          break;
        }
      } catch {
        // 重试
      }
    }
  }

  const unresolved = batch.filter(
    (s) =>
      s.content.join('\n').trim() && validation.accepted[s.id] === undefined,
  ).length;

  return {
    aligned: Object.keys(validation.accepted).length,
    flagged: validation.flagged.length,
    repaired,
    unresolved,
    echoChecked: validation.echoChecked,
  };
}

/** 旧协议（v20 无回显）系统提示词，验证降级兼容 */
const LEGACY_SYSTEM_PROMPT = `您是字幕翻译专家。输入是JSON对象（键为字幕ID，值为原文），请翻译为简体中文。
必须返回与输入相同键数的JSON对象，键为字幕ID，值为译文字符串。只返回纯JSON。
示例输入：{"1": "Hello"} 示例输出：{"1": "你好"}`;

async function onlineChecks(): Promise<void> {
  const srtPath =
    process.env.SRT_PATH ||
    path.join(os.homedir(), 'Downloads/translate/test.srt');
  if (!fs.existsSync(srtPath)) {
    console.log(`online: skipped (srt not found: ${srtPath})`);
    return;
  }
  const entries = parseSrt(srtPath);
  const fastModel = process.env.MODEL || 'gemma2:2b';
  const slowModel = process.env.SLOW_MODEL || 'deepseek-r1:7b';
  const echoSystemPrompt = defaultSystemPrompt
    .replace(/\$\{sourceLanguage\}/g, 'English')
    .replace(/\$\{targetLanguage\}/g, '简体中文')
    .replace(/\$\{glossary\}/g, '');

  // S1: json_schema + 回显（91 条按 45 分批）
  console.log(
    `online S1: ${fastModel} json_schema+echo, ${entries.length} entries, batch 45`,
  );
  for (let i = 0; i < entries.length; i += 45) {
    const batch = entries.slice(i, i + 45);
    const r = await runScenario({
      name: 'S1',
      model: fastModel,
      batch,
      structuredOutput: 'json_schema',
      echo: true,
      systemPrompt: echoSystemPrompt,
    });
    console.log(
      `    batch@${i}: aligned=${r.aligned}/${batch.length} echo=${r.echoChecked} flagged=${r.flagged} repaired=${r.repaired}`,
    );
    ok(
      r.unresolved === 0,
      `S1 batch@${i}: 100% aligned (${batch.length} entries)`,
    );
  }

  // S3: 旧协议提示词 + json_object → 降级校验不中断
  console.log(
    `online S3: ${fastModel} legacy prompt + json_object, 20 entries`,
  );
  {
    const batch = entries.slice(0, 20);
    const r = await runScenario({
      name: 'S3',
      model: fastModel,
      batch,
      structuredOutput: 'json_object',
      echo: true, // 开关开启，但模型按旧协议返回字符串 → 优雅降级
      systemPrompt: LEGACY_SYSTEM_PROMPT,
    });
    console.log(
      `    aligned=${r.aligned}/20 echo=${r.echoChecked} flagged=${r.flagged} repaired=${r.repaired}`,
    );
    ok(
      r.unresolved === 0,
      'S3: legacy protocol completes without pipeline failure',
    );
  }

  // S4: json_object 降级下回显协议仍工作（提示词驱动）
  console.log(`online S4: ${fastModel} echo prompt + json_object, 20 entries`);
  {
    const batch = entries.slice(0, 20);
    const r = await runScenario({
      name: 'S4',
      model: fastModel,
      batch,
      structuredOutput: 'json_object',
      echo: true,
      systemPrompt: echoSystemPrompt,
    });
    console.log(
      `    aligned=${r.aligned}/20 echo=${r.echoChecked} flagged=${r.flagged} repaired=${r.repaired}`,
    );
    ok(r.unresolved === 0, 'S4: echo protocol survives json_object fallback');
  }

  // S2: 合并滑移检出与修复（慢模型，实测高合并率）
  if (process.env.SKIP_SLOW !== '1') {
    console.log(
      `online S2: ${slowModel} json_schema+echo, 45 entries (merge-prone model)`,
    );
    const batch = entries.slice(0, 45);
    const r = await runScenario({
      name: 'S2',
      model: slowModel,
      batch,
      structuredOutput: 'json_schema',
      echo: true,
      systemPrompt: echoSystemPrompt,
    });
    console.log(
      `    aligned=${r.aligned}/45 echo=${r.echoChecked} flagged=${r.flagged} repaired=${r.repaired}`,
    );
    ok(
      r.unresolved === 0,
      'S2: merge-prone model ends 100% aligned after repair',
    );
  } else {
    console.log('online S2: skipped (SKIP_SLOW=1)');
  }
}

async function main(): Promise<void> {
  offlineChecks();
  if (process.env.E2E === '1') {
    await onlineChecks();
  } else {
    console.log(
      'online scenarios skipped (set E2E=1 to run against local ollama)',
    );
  }

  console.log(`\nalignment e2e: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();

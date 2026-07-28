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
  exceedsOneThird,
  hasStrongBatchCopyEvidence,
  validateAnchoredBatch,
} from '../main/translate/utils/alignment';
import {
  classifyUntranslatedEvidence,
  isExactSourceCopyCandidate,
  isLikelyUntranslated,
} from '../main/translate/utils/untranslated';
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
  console.log('offline: isLikelyUntranslated');
  ok(
    isLikelyUntranslated(
      '我眼神都懒得搭理他',
      '我眼神都懒得搭理他',
      'zh',
      'en',
    ),
    'exact source copy is detected across different languages',
  );
  ok(
    isLikelyUntranslated(
      'Please keep moving forward!',
      'please keep moving forward...',
      'en',
      'zh',
    ),
    'case and punctuation-only changes are detected',
  );
  ok(
    isLikelyUntranslated(
      'Please keep moving forward carefully',
      'Please keep moving forwards carefully',
      'en',
      'zh',
    ),
    'long near-copy with a token-level change is detected',
  );
  ok(
    isLikelyUntranslated(
      'Пожалуйста, продолжайте двигаться вперед',
      'Пожалуйста продолжайте двигаться вперед',
      'ru',
      'en',
    ),
    'Unicode scripts are compared instead of being normalized away',
  );
  ok(
    !isLikelyUntranslated(
      'Please keep moving forward',
      '请继续向前走',
      'en',
      'zh',
    ),
    'a real translation is accepted',
  );
  ok(
    !isLikelyUntranslated(
      'Please keep moving forward',
      'Please keep moving forward',
      'en-US',
      'en-GB',
    ),
    'same language code is exempt',
  );
  ok(
    isLikelyUntranslated(
      'Please keep moving forward',
      'Please keep moving forward',
      'auto',
      'zh',
    ),
    'automatic source language still detects cross-script source copies',
  );
  ok(
    !isLikelyUntranslated(
      'Please keep moving forward',
      'Please keep moving forward',
      'en',
      'auto',
    ),
    'unknown target language remains exempt',
  );
  ok(
    !isLikelyUntranslated('Yes', 'Yes', 'en', 'zh') &&
      !isLikelyUntranslated('好', '好', 'zh', 'en') &&
      !isLikelyUntranslated('OK', 'OK', 'zh', 'en'),
    'single-character, title-like, and target-script short text is exempt',
  );
  ok(
    isLikelyUntranslated('继续向前跑', '继续向前跑', 'zh', 'en'),
    'cross-script exact copy with at least two letters is a single-entry strong signal',
  );
  ok(
    !isLikelyUntranslated('2026/02/03 19:30', '2026/02/03 19:30', 'en', 'zh'),
    'numeric content is exempt',
  );
  ok(
    !isLikelyUntranslated(
      'https://github.com/buxuku/SmartSub/issues/283',
      'https://github.com/buxuku/SmartSub/issues/283',
      'en',
      'zh',
    ) &&
      !isLikelyUntranslated(
        'support@example.com',
        'support@example.com',
        'en',
        'zh',
      ),
    'URL and email content is exempt',
  );
  ok(
    !isLikelyUntranslated('OpenAI', 'OpenAI', 'en', 'zh') &&
      !isLikelyUntranslated('Harry Potter', 'Harry Potter', 'en', 'zh') &&
      !isLikelyUntranslated('NASA Apollo', 'NASA Apollo', 'en', 'zh'),
    'single and multi-word proper names are exempt',
  );
  ok(
    isLikelyUntranslated(
      'Please visit https://example.com after the meeting',
      'Please visit https://example.com after the meeting',
      'en',
      'zh',
    ),
    'a URL does not hide surrounding untranslated prose',
  );
  ok(
    isLikelyUntranslated(
      '{\\an8}<i>Please keep moving forward</i>',
      '{\\an8}<i>Please keep moving forward</i>',
      'en',
      'zh',
    ),
    'subtitle formatting tags do not affect detection',
  );
  ok(
    classifyUntranslatedEvidence(
      'Este problema es importante',
      'Este problema é importante',
      'es',
      'pt',
    ) === 'weak' &&
      !isLikelyUntranslated(
        'Este problema es importante',
        'Este problema é importante',
        'es',
        'pt',
      ),
    'same-script Spanish to Portuguese near-copy is weak evidence, not a hard failure',
  );
  ok(
    classifyUntranslatedEvidence(
      'Ovo je veoma važno pitanje',
      'Ovo je veoma važno pitanje',
      'hr',
      'sr',
    ) === 'weak' &&
      !isLikelyUntranslated(
        'Ovo je veoma važno pitanje',
        'Ovo je veoma važno pitanje',
        'hr',
        'sr',
      ),
    'legal same-text Croatian to Serbian output is weak evidence, not a hard failure',
  );
  ok(
    isExactSourceCopyCandidate('闭嘴', '闭嘴', 'zh', 'en') &&
      !isExactSourceCopyCandidate('OpenAI', 'OpenAI', 'zh', 'en') &&
      !isExactSourceCopyCandidate('2026', '2026', 'zh', 'en') &&
      !isExactSourceCopyCandidate(
        'https://example.com',
        'https://example.com',
        'zh',
        'en',
      ),
    'batch candidates include cross-script short copies but exclude target-script names and non-language values',
  );
  ok(
    exceedsOneThird(4, 10) &&
      !exceedsOneThird(3, 9) &&
      hasStrongBatchCopyEvidence(4, 10) &&
      !hasStrongBatchCopyEvidence(1, 2),
    'more-than-one-third uses exact arithmetic and requires two strong copies',
  );

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
    'legacy strings without language context keep empty-value-only behavior',
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

  // 批量结果语义校验：回显正确但 tr 仍为原文，也必须进入现有补翻列表
  const untranslated = validateAnchoredBatch(
    {
      '1': {
        translation: 'Hello world',
        srcEcho: 'Hello world',
        hasEcho: true,
      },
      '2': { translation: '你好吗', srcEcho: 'How are you', hasEcho: true },
      '3': {
        translation: '很高兴认识你',
        srcEcho: 'Nice to meet you',
        hasEcho: true,
      },
    },
    batch,
    true,
    { sourceLanguage: 'en', targetLanguage: 'zh' },
  );
  ok(
    untranslated.flagged.includes('1') &&
      untranslated.untranslated.includes('1') &&
      untranslated.accepted['1'] === undefined,
    'aligned response that copies source is routed to targeted repair',
  );

  const legacyUntranslated = validateAnchoredBatch(
    {
      '1': { translation: 'Hello world', hasEcho: false },
      '2': { translation: '你好吗', hasEcho: false },
      '3': { translation: '很高兴认识你', hasEcho: false },
    },
    batch,
    true,
    { sourceLanguage: 'en', targetLanguage: 'zh' },
  );
  ok(
    legacyUntranslated.flagged.includes('1') &&
      legacyUntranslated.untranslated.includes('1'),
    'legacy string responses receive the same untranslated-output check',
  );

  // 短句/专名即使原样返回也不应误送补翻
  const exemptBatch: Subtitle[] = [
    { id: 'short', startEndTime: '', content: ['Yes'] },
    { id: 'name', startEndTime: '', content: ['Harry Potter'] },
    { id: 'number', startEndTime: '', content: ['2026/02/03'] },
    { id: 'url', startEndTime: '', content: ['https://example.com'] },
  ];
  const exemptions = validateAnchoredBatch(
    Object.fromEntries(
      exemptBatch.map((subtitle) => [
        subtitle.id,
        {
          translation: subtitle.content[0],
          srcEcho: subtitle.content[0],
          hasEcho: true,
        },
      ]),
    ),
    exemptBatch,
    true,
    { sourceLanguage: 'en', targetLanguage: 'zh' },
  );
  ok(
    exemptions.flagged.length === 0 &&
      Object.keys(exemptions.accepted).length === exemptBatch.length,
    'short/name/number/URL batch entries remain accepted',
  );

  // Issue #283 原始 10 条：本地模型按旧字符串协议逐条原样返回。
  const issue283Source = [
    '我眼神都懒得搭理他',
    '继续向前跑',
    '老公',
    '你跟他说什么话啊',
    '你看看他都干了些什么',
    '地上躺了这么多',
    '好多好多人',
    '我们要报警把他抓起来',
    '闭嘴',
    '快跟上',
  ];
  const issue283Batch: Subtitle[] = issue283Source.map((content, index) => ({
    id: String(index + 1),
    startEndTime: '',
    content: [content],
  }));
  const issue283Parsed = parseAIAnchoredTranslationResponse(
    JSON.stringify(
      Object.fromEntries(
        issue283Batch.map((subtitle) => [subtitle.id, subtitle.content[0]]),
      ),
    ),
  );
  const issue283Validation = validateAnchoredBatch(
    issue283Parsed,
    issue283Batch,
    true,
    { sourceLanguage: 'zh', targetLanguage: 'en' },
  );
  ok(
    issue283Validation.flagged.join(',') ===
      issue283Batch.map((subtitle) => subtitle.id).join(',') &&
      issue283Validation.untranslated.length === 10 &&
      issue283Validation.promotedExactCopies.length === 0 &&
      Object.keys(issue283Validation.accepted).length === 0,
    'issue #283: all ten cross-script exact copies are rejected',
  );

  // 正常混合批次：单个短复制不足以升级；目标文字专名与非语言内容保持原样。
  const normalMixedBatch: Subtitle[] = [
    { id: '1', startEndTime: '', content: ['我们现在开始准备工作'] },
    { id: '2', startEndTime: '', content: ['OK'] },
    { id: '3', startEndTime: '', content: ['OpenAI'] },
    { id: '4', startEndTime: '', content: ['2026'] },
    { id: '5', startEndTime: '', content: ['https://example.com'] },
    { id: '6', startEndTime: '', content: ['support@example.com'] },
  ];
  const normalMixedValidation = validateAnchoredBatch(
    {
      '1': {
        translation: 'We are starting the preparations now',
        hasEcho: false,
      },
      '2': { translation: 'OK', hasEcho: false },
      '3': { translation: 'OpenAI', hasEcho: false },
      '4': { translation: '2026', hasEcho: false },
      '5': { translation: 'https://example.com', hasEcho: false },
      '6': { translation: 'support@example.com', hasEcho: false },
    },
    normalMixedBatch,
    false,
    { sourceLanguage: 'zh', targetLanguage: 'en' },
  );
  ok(
    normalMixedValidation.flagged.length === 0 &&
      normalMixedValidation.accepted['2'] === 'OK' &&
      normalMixedValidation.accepted['3'] === 'OpenAI',
    'normal mixed batch retains target-script short text, names, and non-language values',
  );

  // 群体证据成立时，标题式/全大写弱豁免可以升级；目标文字专名仍不参与候选。
  const evidenceBatch: Subtitle[] = [
    { id: '1', startEndTime: '', content: ['Please keep moving forward'] },
    { id: '2', startEndTime: '', content: ['We need to leave right now'] },
    { id: '3', startEndTime: '', content: ['This problem is very important'] },
    { id: '4', startEndTime: '', content: ['You should listen carefully'] },
    { id: '5', startEndTime: '', content: ['STOP RIGHT THERE'] },
    { id: '6', startEndTime: '', content: ['Harry Potter'] },
    { id: '7', startEndTime: '', content: ['好'] },
    { id: '8', startEndTime: '', content: ['2026'] },
    { id: '9', startEndTime: '', content: ['https://example.com'] },
    { id: '10', startEndTime: '', content: ['support@example.com'] },
  ];
  const evidenceValidation = validateAnchoredBatch(
    Object.fromEntries(
      evidenceBatch.map((subtitle) => [
        subtitle.id,
        { translation: subtitle.content[0], hasEcho: false },
      ]),
    ),
    evidenceBatch,
    false,
    { sourceLanguage: 'en', targetLanguage: 'zh' },
  );
  ok(
    evidenceValidation.flagged.join(',') === '1,2,3,4,5,6' &&
      evidenceValidation.promotedExactCopies.join(',') === '5,6' &&
      evidenceValidation.weakUntranslated.length === 0 &&
      evidenceValidation.accepted['7'] === '好' &&
      evidenceValidation.accepted['8'] === '2026',
    'batch evidence promotes title/name weak copies while retaining one-character and non-language values',
  );

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
      repair.prompt.includes('不要把原文直接复制为译文') &&
      repair.prompt.includes('"2"'),
    'repair prompt quotes target line and explicitly rejects source copying',
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
  const validation = validateAnchoredBatch(parsed, batch, params.echo, {
    sourceLanguage: 'en',
    targetLanguage: 'zh',
  });

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
        if (
          translation &&
          !isLikelyUntranslated(
            subtitle.content.join('\n'),
            translation,
            'en',
            'zh',
          ) &&
          !(
            validation.untranslated.includes(flaggedId) &&
            isExactSourceCopyCandidate(
              subtitle.content.join('\n'),
              translation,
              'en',
              'zh',
            )
          )
        ) {
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

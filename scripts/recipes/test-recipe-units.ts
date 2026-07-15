/**
 * 向导纯函数单元验证（配方 + 配对，无 electron/window 依赖）。
 * 运行：yarn test:recipes
 *
 * 覆盖：
 *  - recipeSlug/recipeTarget：纯字幕配方 → 任务页 slug；含配音/成片 → 向导 ?recipe=
 *  - recipeBlock：模型/翻译/TTS 就绪阻断优先级
 *  - recipeToWizardPrefill：gates 回填（缺省=字幕校对开、配音确认关）
 *  - recipeStageKeys：用户配方卡阶段链描述
 *  - 内置配方常量形状与 builtinCardKey 文案键映射
 *  - pairMediaWithSubtitles：同名配对（精确/语言后缀前缀/txt 排除/去重占用）
 */

import {
  BUILTIN_RECIPES,
  builtinCardKey,
  recipeBlock,
  recipeBlockHref,
  recipeHasExtraStages,
  recipeSlug,
  recipeStageKeys,
  recipeTarget,
  recipeToWizardPrefill,
} from '../../renderer/lib/recipes';
import { pairMediaWithSubtitles } from '../../renderer/lib/filePairing';
import type { TaskRecipe } from '../../types/recipe';

let failed = 0;

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  const ok = a === b;
  if (!ok) failed++;
  console.log(
    `${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n   expected=${b}\n   actual  =${a}`}`,
  );
}

const recipe = (over: Partial<TaskRecipe>): TaskRecipe => ({
  id: 'r1',
  name: 'test',
  goals: { translate: false, dub: false, video: false },
  accepts: 'media',
  ...over,
});

const READY = { hasModels: true, hasProvider: true, ttsReady: true };

// ── recipeSlug / recipeTarget ───────────────────────────────────────────────

eq(
  recipeSlug(recipe({ goals: { translate: false, dub: false, video: false } })),
  'generate',
  'recipeSlug: 纯转写 → generate',
);
eq(
  recipeSlug(recipe({ goals: { translate: true, dub: false, video: false } })),
  'generate-translate',
  'recipeSlug: 转写+翻译 → generate-translate',
);
eq(
  recipeSlug(
    recipe({
      accepts: 'subtitle',
      goals: { translate: true, dub: false, video: false },
    }),
  ),
  'translate',
  'recipeSlug: 字幕输入 → translate',
);
eq(
  recipeSlug(recipe({ goals: { translate: true, dub: true, video: false } })),
  null,
  'recipeSlug: 含配音 → null（走向导）',
);
eq(
  recipeSlug(recipe({ goals: { translate: true, dub: false, video: true } })),
  null,
  'recipeSlug: 含成片 → null（走向导）',
);
eq(
  recipeHasExtraStages(
    recipe({ goals: { translate: true, dub: false, video: false } }),
  ),
  false,
  'recipeHasExtraStages: 纯字幕 → false',
);
eq(
  recipeTarget(
    recipe({ goals: { translate: true, dub: false, video: false } }),
    'zh',
  ),
  '/zh/tasks/generate-translate',
  'recipeTarget: 纯字幕 → 任务页路由',
);
eq(
  recipeTarget(
    recipe({ id: 'u 1', goals: { translate: true, dub: true, video: true } }),
    'en',
  ),
  '/en/tasks/new?recipe=u%201',
  'recipeTarget: 含附加阶段 → 向导 ?recipe=（id 转义）',
);

// ── recipeBlock ─────────────────────────────────────────────────────────────

eq(
  recipeBlock(
    recipe({ goals: { translate: true, dub: true, video: true } }),
    READY,
  ),
  null,
  'recipeBlock: 全就绪 → null',
);
eq(
  recipeBlock(recipe({ goals: { translate: true, dub: true, video: true } }), {
    ...READY,
    hasModels: false,
  }),
  'model',
  'recipeBlock: media 输入缺模型 → model（最高优先）',
);
eq(
  recipeBlock(
    recipe({
      accepts: 'subtitle',
      goals: { translate: true, dub: false, video: false },
    }),
    { ...READY, hasModels: false },
  ),
  null,
  'recipeBlock: 字幕输入不需要模型',
);
eq(
  recipeBlock(recipe({ goals: { translate: true, dub: true, video: false } }), {
    ...READY,
    hasProvider: false,
  }),
  'provider',
  'recipeBlock: 勾翻译缺服务商 → provider',
);
eq(
  recipeBlock(recipe({ goals: { translate: false, dub: true, video: true } }), {
    ...READY,
    hasProvider: false,
  }),
  null,
  'recipeBlock: 不翻译则不查服务商',
);
eq(
  recipeBlock(
    recipe({ goals: { translate: false, dub: true, video: false } }),
    { ...READY, ttsReady: false },
  ),
  'tts',
  'recipeBlock: 勾配音缺 TTS → tts',
);
eq(recipeBlockHref('zh', 'model'), '/zh/engines', 'recipeBlockHref: model');
eq(
  recipeBlockHref('zh', 'provider'),
  '/zh/translation',
  'recipeBlockHref: provider',
);
eq(recipeBlockHref('en', 'tts'), '/en/ttsServices', 'recipeBlockHref: tts');

// ── recipeToWizardPrefill ───────────────────────────────────────────────────

{
  const p = recipeToWizardPrefill(
    recipe({ goals: { translate: true, dub: true, video: true } }),
  );
  eq(
    [p.subtitleGateOn, p.dubbingGateOn, p.config],
    [true, false, null],
    'prefill: 无 config → 默认字幕校对开、配音确认关',
  );
}
{
  const p = recipeToWizardPrefill(
    recipe({
      goals: { translate: true, dub: true, video: true },
      config: {
        gates: { subtitle: 'auto', dubbing: 'manual' },
        sourceLanguage: 'en',
      },
    }),
  );
  eq(
    [p.subtitleGateOn, p.dubbingGateOn, p.goals.dub],
    [false, true, true],
    'prefill: gates 档位回填 + goals 拷贝',
  );
  eq(
    (p.config as Record<string, unknown>)?.sourceLanguage,
    'en',
    'prefill: config 原样透传（浅合并交给向导）',
  );
}

// ── recipeStageKeys ─────────────────────────────────────────────────────────

eq(
  recipeStageKeys(
    recipe({ goals: { translate: true, dub: true, video: true } }),
  ),
  ['transcribe', 'translate', 'dubbing', 'compose'],
  'stageKeys: media 全链',
);
eq(
  recipeStageKeys(
    recipe({
      accepts: 'subtitle',
      goals: { translate: true, dub: true, video: false },
    }),
  ),
  ['translate', 'dubbing'],
  'stageKeys: 字幕输入无转写',
);

// ── 内置配方常量 ────────────────────────────────────────────────────────────

eq(BUILTIN_RECIPES.length, 4, 'builtin: 4 张内置配方');
eq(
  BUILTIN_RECIPES.map((r) => builtinCardKey(r.id)),
  ['pipeline', 'generateTranslate', 'generate', 'translate'],
  'builtin: 文案键映射沿用旧卡片',
);
eq(
  BUILTIN_RECIPES.map((r) => recipeSlug(r)),
  [null, 'generate-translate', 'generate', 'translate'],
  'builtin: 一条龙走向导，其余直达任务页（零回归）',
);
eq(
  BUILTIN_RECIPES[0].config?.gates,
  { subtitle: 'manual', dubbing: 'auto' },
  'builtin: 一条龙默认把关 = 字幕校对开、配音确认关',
);
eq(
  BUILTIN_RECIPES.every((r) => r.builtin === true),
  true,
  'builtin: 均标记 builtin',
);

// ── pairMediaWithSubtitles ──────────────────────────────────────────────────

const pf = (filePath: string) => ({
  filePath,
  fileName: filePath
    .split('/')
    .pop()!
    .replace(/\.[^.]+$/, ''),
});

{
  const r = pairMediaWithSubtitles(
    [pf('/v/a.mp4'), pf('/v/b.mp4')],
    [pf('/v/a.srt'), pf('/v/b.srt')],
  );
  eq(
    r.pairs.map((p) => [p.media.fileName, p.subtitle.fileName]),
    [
      ['a', 'a'],
      ['b', 'b'],
    ],
    'pair: 精确同名配对',
  );
  eq(
    [r.unpairedMedia.length, r.unpairedSubtitles.length],
    [0, 0],
    'pair: 全配对无剩余',
  );
}
{
  const r = pairMediaWithSubtitles(
    [pf('/v/a.mp4')],
    [pf('/v/a.zh.srt'), pf('/v/a.en.srt')],
  );
  eq(
    r.pairs[0]?.subtitle.fileName,
    'a.en',
    'pair: 语言后缀前缀匹配（多候选取排序首个）',
  );
  eq(
    r.unpairedSubtitles.map((s) => s.fileName),
    ['a.zh'],
    'pair: 未选中的候选归入未配对',
  );
}
{
  const r = pairMediaWithSubtitles(
    [pf('/v/a.mp4'), pf('/v/ab.mp4')],
    [pf('/v/ab.srt')],
  );
  eq(
    [
      r.pairs.map((p) => [p.media.fileName, p.subtitle.fileName]),
      r.unpairedMedia.map((m) => m.fileName),
    ],
    [[['ab', 'ab']], ['a']],
    'pair: 主干前缀不误配（a 不吃 ab.srt）',
  );
}
{
  const r = pairMediaWithSubtitles([pf('/v/a.mp4')], [pf('/v/a.txt')]);
  eq(
    [r.pairs.length, r.unpairedMedia.length, r.unpairedSubtitles.length],
    [0, 1, 1],
    'pair: txt 不参与配对',
  );
}
{
  // 同一字幕不被两个视频重复占用
  const r = pairMediaWithSubtitles(
    [pf('/v/a.mp4'), pf('/w/a.mkv')],
    [pf('/v/a.srt')],
  );
  eq(
    [r.pairs.length, r.unpairedMedia.map((m) => m.filePath)],
    [1, ['/w/a.mkv']],
    'pair: 字幕单次占用（先到先得）',
  );
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log('\nAll recipe unit cases passed');

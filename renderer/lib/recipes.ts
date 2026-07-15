/**
 * 任务配方（P4）：内置配方常量 + 应用/阻断推导纯函数（可单测，无 window 依赖）。
 * 应用规则（design D1）：纯字幕配方 → 直达既有任务页 /tasks/[slug]（拖放直建工程，
 * 功能面零回归）；含配音/成片阶段 → 向导 ?recipe=<id> 预填（拖放经 sessionStorage 交接）。
 */
import type { IFormData } from '../../types';
import type { RecipeGoals, TaskRecipe } from '../../types/recipe';

/** 启动台拖放带入向导的 sessionStorage 交接键 */
export const WIZARD_DROP_KEY = 'wizard:droppedFiles';

/**
 * 内置配方（代码常量不落库，升级迭代无需数据迁移）。
 * 卡片文案由 launchpad.json card.* 按 builtinCardKey(id) 解析，name 留空。
 */
export const BUILTIN_RECIPES: TaskRecipe[] = [
  {
    id: 'builtin-pipeline',
    name: '',
    builtin: true,
    goals: { translate: true, dub: true, video: true },
    accepts: 'media',
    // 一条龙默认把关：字幕校对开（错字会带进配音与成片）、配音确认关
    config: { gates: { subtitle: 'manual', dubbing: 'auto' } },
  },
  {
    id: 'builtin-generate-translate',
    name: '',
    builtin: true,
    goals: { translate: true, dub: false, video: false },
    accepts: 'media',
  },
  {
    id: 'builtin-generate',
    name: '',
    builtin: true,
    goals: { translate: false, dub: false, video: false },
    accepts: 'media',
  },
  {
    id: 'builtin-translate',
    name: '',
    builtin: true,
    goals: { translate: true, dub: false, video: false },
    accepts: 'subtitle',
  },
];

/** 内置配方 id → launchpad.json card.* 文案键（沿用旧卡片文案，深链习惯不破坏） */
export function builtinCardKey(id: string): string {
  switch (id) {
    case 'builtin-pipeline':
      return 'pipeline';
    case 'builtin-generate-translate':
      return 'generateTranslate';
    case 'builtin-generate':
      return 'generate';
    case 'builtin-translate':
      return 'translate';
    default:
      return id;
  }
}

/** 含附加阶段（配音/成片）的配方走向导；纯字幕配方直达既有任务页 */
export function recipeHasExtraStages(recipe: TaskRecipe): boolean {
  return recipe.goals.dub || recipe.goals.video;
}

/** 纯字幕配方对应的任务页 slug；含附加阶段返回 null（走向导） */
export function recipeSlug(recipe: TaskRecipe): string | null {
  if (recipeHasExtraStages(recipe)) return null;
  if (recipe.accepts === 'subtitle') return 'translate';
  return recipe.goals.translate ? 'generate-translate' : 'generate';
}

/** 卡片点击/拖放跳转目标：纯字幕 → 任务页；含附加阶段 → 向导预填 */
export function recipeTarget(recipe: TaskRecipe, locale: string): string {
  const slug = recipeSlug(recipe);
  return slug
    ? `/${locale}/tasks/${slug}`
    : `/${locale}/tasks/new?recipe=${encodeURIComponent(recipe.id)}`;
}

export interface RecipeReadiness {
  hasModels: boolean;
  hasProvider: boolean;
  ttsReady: boolean;
}

export type RecipeBlockKind = 'model' | 'provider' | 'tts';

/** 就绪阻断推导：转写（media 输入）→ 模型；翻译 → 翻译服务；配音 → TTS 就绪 */
export function recipeBlock(
  recipe: TaskRecipe,
  ready: RecipeReadiness,
): RecipeBlockKind | null {
  if (recipe.accepts === 'media' && !ready.hasModels) return 'model';
  if (recipe.goals.translate && !ready.hasProvider) return 'provider';
  if (recipe.goals.dub && !ready.ttsReady) return 'tts';
  return null;
}

/** 阻断对应的配置页路径 */
export function recipeBlockHref(
  locale: string,
  block: RecipeBlockKind,
): string {
  switch (block) {
    case 'model':
      return `/${locale}/engines`;
    case 'provider':
      return `/${locale}/translation`;
    case 'tts':
      return `/${locale}/ttsServices`;
  }
}

/** 向导预填包：goals/gates 开关状态 + 待浅合并的表单 config */
export interface RecipeWizardPrefill {
  goals: RecipeGoals;
  subtitleGateOn: boolean;
  dubbingGateOn: boolean;
  config: Partial<IFormData> | null;
}

export function recipeToWizardPrefill(recipe: TaskRecipe): RecipeWizardPrefill {
  const gates = recipe.config?.gates;
  return {
    goals: { ...recipe.goals },
    // 缺省语义与向导默认一致：字幕校对开、配音确认关
    subtitleGateOn: gates ? gates.subtitle === 'manual' : true,
    dubbingGateOn: gates ? gates.dubbing === 'manual' : false,
    config: recipe.config ?? null,
  };
}

/** 配方阶段链（键名对齐 launchpad.json pipeline.*），用户配方卡描述用 */
export function recipeStageKeys(recipe: TaskRecipe): string[] {
  const keys: string[] = [];
  if (recipe.accepts === 'media') keys.push('transcribe');
  if (recipe.goals.translate) keys.push('translate');
  if (recipe.goals.dub) keys.push('dubbing');
  if (recipe.goals.video) keys.push('compose');
  return keys;
}

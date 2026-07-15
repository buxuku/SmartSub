/**
 * 任务配方：向导状态（目标勾选 + 完整任务配置）的命名快照。
 * 内置配方为代码常量（renderer/lib/recipes.ts，i18n 命名不落库）；
 * 用户配方持久化于 store `taskRecipes`，经 recipes:* IPC 薄 CRUD 管理。
 */
import type { IFormData } from './types';

/** 向导目标勾选（字幕恒产出，不入模型） */
export interface RecipeGoals {
  translate: boolean;
  dub: boolean;
  video: boolean;
}

export interface TaskRecipe {
  id: string;
  /** 用户配方显示名；内置配方留空，由 renderer 按 id 解析 i18n 文案 */
  name: string;
  builtin?: boolean;
  goals: RecipeGoals;
  /** 输入类型：决定卡片路由与拖放文件过滤 */
  accepts: 'media' | 'subtitle';
  /**
   * 任务配置快照（字幕段字段 + dub/compose/gates）。
   * 应用时浅合并到向导当前默认值之上：缺字段回落默认，不做严格 schema 校验；
   * 引擎/服务商失效由向导既有就绪校验兜底。
   */
  config?: Partial<IFormData>;
  /** 创建时间（用户配方；覆盖保存时保留首次创建时间） */
  createdAt?: number;
}

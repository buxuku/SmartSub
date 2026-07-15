/**
 * 任务配方 IPC（薄 CRUD，形制同 workItemHandlers）：
 * recipes:list / save / rename / delete。内置配方为 renderer 代码常量不落库，
 * 这里只管理用户配方；save 按 id 幂等 upsert（保留首次创建时间）。
 */
import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { store, logMessage } from './storeManager';
import type { TaskRecipe } from '../../types/recipe';

function readRecipes(): TaskRecipe[] {
  const list = store.get('taskRecipes');
  return Array.isArray(list) ? list : [];
}

export function setupRecipeHandlers(): void {
  ipcMain.handle('recipes:list', () => readRecipes());

  ipcMain.handle('recipes:save', (_event, recipe: Partial<TaskRecipe>) => {
    const name = recipe?.name?.trim();
    if (!name || !recipe?.goals || !recipe?.accepts) return null;
    const list = readRecipes();
    const saved: TaskRecipe = {
      id: recipe.id || randomUUID(),
      name,
      goals: recipe.goals,
      accepts: recipe.accepts,
      config: recipe.config,
      createdAt: Date.now(),
    };
    const index = list.findIndex((r) => r.id === saved.id);
    if (index >= 0) {
      saved.createdAt = list[index].createdAt ?? saved.createdAt;
      list[index] = saved;
    } else {
      list.push(saved);
    }
    store.set('taskRecipes', list);
    return saved;
  });

  ipcMain.handle(
    'recipes:rename',
    (_event, payload: { id: string; name: string }) => {
      const name = payload?.name?.trim();
      if (!payload?.id || !name) return null;
      const list = readRecipes();
      const index = list.findIndex((r) => r.id === payload.id);
      if (index < 0) return null;
      list[index] = { ...list[index], name };
      store.set('taskRecipes', list);
      return list[index];
    },
  );

  ipcMain.handle('recipes:delete', (_event, id: string) => {
    const list = readRecipes();
    const next = list.filter((r) => r.id !== id);
    if (next.length === list.length) return false;
    store.set('taskRecipes', next);
    return true;
  });

  logMessage('任务配方 IPC 处理函数已注册', 'info');
}

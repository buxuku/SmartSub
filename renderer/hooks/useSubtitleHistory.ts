/**
 * 命令模式撤销历史：统一的连续区间 diff 命令栈。
 * 单行编辑 / 合并 / 拆分 / 批量替换都表达为同一种命令，
 * 相比整数组快照，内存占用从 O(n×历史数) 降到 O(改动行数×历史数)。
 */

import { useCallback, useRef, useState } from 'react';
import { Subtitle } from './useSubtitles';

export interface RangeCommand {
  /** 区间起点（应用前数组中的下标） */
  start: number;
  /** undo 时回填的原始行 */
  removed: Subtitle[];
  /** redo 时回填的新行 */
  inserted: Subtitle[];
}

const MAX_HISTORY = 200;

/** 行内容等价（用于批量操作的最小区间 diff 计算） */
export const subtitleRowEquals = (a: Subtitle, b: Subtitle): boolean =>
  a === b ||
  (a.id === b.id &&
    a.startEndTime === b.startEndTime &&
    (a.sourceContent ?? '') === (b.sourceContent ?? '') &&
    (a.targetContent ?? '') === (b.targetContent ?? ''));

/**
 * 计算 before → after 的最小连续区间 diff；无变化返回 null。
 * 公共前缀/后缀按行内容等价跳过，中间段作为命令区间。
 */
export const computeRangeDiff = (
  before: Subtitle[],
  after: Subtitle[],
): RangeCommand | null => {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (
    prefix < maxPrefix &&
    subtitleRowEquals(before[prefix], after[prefix])
  ) {
    prefix++;
  }

  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (
    suffix < maxSuffix &&
    subtitleRowEquals(
      before[before.length - 1 - suffix],
      after[after.length - 1 - suffix],
    )
  ) {
    suffix++;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const inserted = after.slice(prefix, after.length - suffix);
  if (removed.length === 0 && inserted.length === 0) return null;
  return { start: prefix, removed, inserted };
};

export function useSubtitleHistory() {
  const commandsRef = useRef<RangeCommand[]>([]);
  const cursorRef = useRef(0);
  // 仅用于在栈变化后触发重渲染，让 canUndo/canRedo 反映最新值
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const push = useCallback(
    (cmd: RangeCommand) => {
      // 新命令入栈：丢弃 redo 分支
      const cmds = commandsRef.current.slice(0, cursorRef.current);
      cmds.push(cmd);
      while (cmds.length > MAX_HISTORY) cmds.shift();
      commandsRef.current = cmds;
      cursorRef.current = cmds.length;
      bump();
    },
    [bump],
  );

  const reset = useCallback(() => {
    commandsRef.current = [];
    cursorRef.current = 0;
    bump();
  }, [bump]);

  /** 应用撤销：返回新数组；无可撤销或数据漂移时返回 null */
  const undo = useCallback(
    (current: Subtitle[]): Subtitle[] | null => {
      if (cursorRef.current <= 0) return null;
      const cmd = commandsRef.current[cursorRef.current - 1];
      // 区间防御：命令与当前数组不再吻合时清栈，避免错位应用
      if (cmd.start < 0 || cmd.start + cmd.inserted.length > current.length) {
        reset();
        return null;
      }
      const next = current.slice();
      next.splice(cmd.start, cmd.inserted.length, ...cmd.removed);
      cursorRef.current -= 1;
      bump();
      return next;
    },
    [bump, reset],
  );

  /** 应用重做：返回新数组；无可重做或数据漂移时返回 null */
  const redo = useCallback(
    (current: Subtitle[]): Subtitle[] | null => {
      if (cursorRef.current >= commandsRef.current.length) return null;
      const cmd = commandsRef.current[cursorRef.current];
      if (cmd.start < 0 || cmd.start + cmd.removed.length > current.length) {
        reset();
        return null;
      }
      const next = current.slice();
      next.splice(cmd.start, cmd.removed.length, ...cmd.inserted);
      cursorRef.current += 1;
      bump();
      return next;
    },
    [bump, reset],
  );

  return {
    push,
    undo,
    redo,
    reset,
    canUndo: cursorRef.current > 0,
    canRedo: cursorRef.current < commandsRef.current.length,
  };
}

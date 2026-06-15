import { useEffect } from 'react';

// 当前是否还有「会锁 body」的 Radix 浮层处于打开状态：
// - 模态弹窗：[role="dialog"|"alertdialog"][data-state="open"]
// - 基于 popper 的浮层（DropdownMenu/Select/Popover 等）：[data-radix-popper-content-wrapper]
const hasOpenRadixOverlay = (): boolean =>
  !!document.querySelector(
    '[data-state="open"][role="dialog"],' +
      '[data-state="open"][role="alertdialog"],' +
      '[data-radix-popper-content-wrapper]',
  );

/**
 * 兜底修复 Radix 已知问题：从 DropdownMenu 中打开 Dialog（或浮层快速开关）时，
 * body 的 `pointer-events: none` 锁可能在关闭后未被还原，导致整页无法点击、只能刷新。
 *
 * 不修改组件库：在应用层全局监听 body 的 style / 子节点（浮层 portal 挂载在 body 下）变化，
 * 当确实没有任何浮层打开、但 body 仍残留 `pointer-events: none` 时清除它。
 * 浮层正常打开期间不会误清除（此时本就应锁定背景）。
 */
export function useRadixPointerEventsGuard(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const body = document.body;

    const restoreIfStuck = () => {
      if (body.style.pointerEvents !== 'none') return;
      if (hasOpenRadixOverlay()) return; // 仍有浮层打开，保持锁定
      body.style.pointerEvents = '';
    };

    // 延后到下一帧，等 Radix 完成本轮 DOM 变更后再判定，避免与其开关时序竞争
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(restoreIfStuck);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(body, {
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
    });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);
}

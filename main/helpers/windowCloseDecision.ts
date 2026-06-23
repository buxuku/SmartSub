/**
 * 关闭窗口意图决策（纯函数，无 Electron 依赖，便于 test:engines 覆盖）。
 * 行为矩阵见 docs/superpowers/specs/2026-06-15-macos-close-behavior-design.md §2。
 */
export type CloseAction = 'smart' | 'background' | 'quit';

/**
 * - 'quit'：直接真退出（由调用方走 app.quit → before-quit 优雅关闭）
 * - 'confirm-quit'：有任务在跑，先二次确认再退
 * - 'background'：转入后台（隐藏窗口；首次提示由 UI 层处理）
 */
export type CloseIntent = 'quit' | 'confirm-quit' | 'background';

export function decideCloseIntent(input: {
  platform: NodeJS.Platform;
  closeAction: CloseAction;
  busy: boolean;
}): CloseIntent {
  const { platform, closeAction, busy } = input;

  // 非 macOS：不做隐藏到后台（无托盘会找不到窗口）。忙碌则二次确认防误杀，空闲直接退。
  if (platform !== 'darwin') {
    return busy ? 'confirm-quit' : 'quit';
  }

  // macOS：按设置走。
  if (closeAction === 'background') return 'background';
  if (closeAction === 'quit') return busy ? 'confirm-quit' : 'quit';
  // 'smart'（默认/兜底）：有任务转后台，空闲直接退。
  return busy ? 'background' : 'quit';
}

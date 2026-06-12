import { useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';

/**
 * 危险操作统一交互：立即执行 + 5 秒撤销 toast（Linear/Notion 模式）。
 *
 * 调用方先自行快照旧状态并应用变更，再调用本函数给出撤销入口：
 *
 *   const confirmOrUndo = useConfirmOrUndo();
 *   const prev = files;
 *   setFiles([]);
 *   confirmOrUndo(t('listCleared'), () => setFiles(prev));
 */
export function useConfirmOrUndo() {
  const { t } = useTranslation('common');

  return useCallback(
    (message: string, undo: () => void) => {
      toast(message, {
        action: {
          label: t('undo') || '撤销',
          onClick: undo,
        },
        duration: 5000,
      });
    },
    [t],
  );
}

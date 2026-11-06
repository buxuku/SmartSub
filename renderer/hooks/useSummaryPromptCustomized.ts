import { useCallback, useEffect, useRef, useState } from 'react';
import { isSummaryPromptCustomized } from '../../types/summaryPrompt';

/**
 * 摘要提示词是否已被改写（只读，给入口处的「已自定义」小徽标用）。
 *
 * 不订阅写入：入口展开、编辑弹窗关闭时由调用方 refresh() 取最新值即可。
 * 读取失败时保持上一次的值，徽标只是提示，不值得打断用户。
 */
export function useSummaryPromptCustomized(): {
  customized: boolean;
  refresh: () => Promise<void>;
} {
  const [customized, setCustomized] = useState(false);
  const alive = useRef(true);
  const epoch = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const token = ++epoch.current;
    try {
      const settings = await window?.ipc?.invoke('getSettings');
      if (!alive.current || token !== epoch.current) return;
      setCustomized(isSummaryPromptCustomized(settings?.summaryPrompt));
    } catch {
      // 保持上一次的值
    }
  }, []);

  return { customized, refresh };
}

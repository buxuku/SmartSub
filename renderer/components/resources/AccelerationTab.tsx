import React, { useEffect } from 'react';
import { useRouter } from 'next/router';
import { RefreshCw } from 'lucide-react';

/**
 * 过渡薄重定向：GPU 加速已折叠进 builtin 引擎面板（见 fold-gpu-into-builtin）。
 *
 * 「加速」Tab 本身的最终移除与导航重构归 `split-resource-center-nav`；在此之前保留本组件，
 * 把旧 `?tab=acceleration` 深链接（及全景页加速卡等入口经 Tab 切换而来的导航）统一重定向到
 * 引擎 Tab 并选中 builtin，避免外部书签/旧链接失效。
 */
const AccelerationTab: React.FC = () => {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    try {
      localStorage.setItem(
        'engineModelSelectedView',
        JSON.stringify('builtin'),
      );
    } catch {
      // 忽略：localStorage 不可用时仍重定向，EngineModelTab 回落默认 builtin
    }
    router.replace(
      { pathname: router.pathname, query: { ...router.query, tab: 'engines' } },
      undefined,
      { shallow: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  return (
    <div className="flex items-center justify-center py-8">
      <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
};

export default AccelerationTab;

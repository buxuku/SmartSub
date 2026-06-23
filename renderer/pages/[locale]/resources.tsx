import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { RefreshCw } from 'lucide-react';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 资源中心已拆为「引擎与模型」(`/engines`) 与「翻译服务」(`/translation`) 两个顶级页
 * （见 split-resource-center-nav）。本页降级为薄重定向，保住旧 `/resources?tab=*` 深链接 / 书签：
 *
 *   无 tab / overview / engines / models → /engines
 *   providers                            → /translation
 *   acceleration                         → /engines（GPU 已折叠进 builtin，预选 builtin）
 */
const ResourcesRedirect = () => {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    const locale = router.query.locale as string;
    const tab = router.query.tab as string | undefined;

    if (tab === 'providers') {
      router.replace(`/${locale}/translation`);
      return;
    }

    if (tab === 'acceleration') {
      try {
        localStorage.setItem(
          'engineModelSelectedView',
          JSON.stringify('builtin'),
        );
      } catch {
        // 忽略：localStorage 不可用时仍重定向，EngineModelTab 回落默认 builtin
      }
    }
    router.replace(`/${locale}/engines`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  return (
    <div className="flex h-full items-center justify-center py-8">
      <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
};

export default ResourcesRedirect;

export const getStaticProps = makeStaticProperties(['common']);
export { getStaticPaths };

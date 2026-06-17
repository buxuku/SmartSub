import React, { useEffect } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PageHeader from '@/components/PageHeader';
import OverviewTab from '@/components/resources/OverviewTab';
import ProvidersTab from '@/components/resources/ProvidersTab';
import AccelerationTab from '@/components/resources/AccelerationTab';
import EngineModelTab from '@/components/resources/EngineModelTab';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

export const RESOURCE_TABS = [
  'overview',
  'engines',
  'providers',
  'acceleration',
] as const;
export type ResourceTab = (typeof RESOURCE_TABS)[number];

// 旧深链接归一：引擎与模型合并为单一 Tab（规范键 engines），`?tab=models` 重定向到 engines。
const TAB_ALIASES: Record<string, ResourceTab> = { models: 'engines' };

const Resources = () => {
  const { t } = useTranslation('resources');
  const router = useRouter();
  const queryTab = router.query.tab as string | undefined;
  const aliased = queryTab ? TAB_ALIASES[queryTab] : undefined;
  const activeTab: ResourceTab =
    aliased ??
    ((RESOURCE_TABS as readonly string[]).includes(queryTab ?? '')
      ? (queryTab as ResourceTab)
      : 'overview');

  // 别名深链接（如 ?tab=models）落地后把 URL 归一到规范键，避免地址栏停留在旧键。
  useEffect(() => {
    if (!router.isReady) return;
    if (queryTab && TAB_ALIASES[queryTab]) {
      router.replace(
        {
          pathname: router.pathname,
          query: { ...router.query, tab: TAB_ALIASES[queryTab] },
        },
        undefined,
        { shallow: true },
      );
    }
  }, [router.isReady, queryTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTabChange = (value: string) => {
    router.replace(
      { pathname: router.pathname, query: { ...router.query, tab: value } },
      undefined,
      { shallow: true },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader title={t('title')} description={t('description')} />
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="w-fit">
          {RESOURCE_TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`tab.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto">
          <OverviewTab onNavigateTab={handleTabChange} />
        </TabsContent>
        <TabsContent value="engines" className="min-h-0 flex-1 overflow-auto">
          <EngineModelTab />
        </TabsContent>
        <TabsContent value="providers" className="min-h-0 flex-1">
          <ProvidersTab />
        </TabsContent>
        <TabsContent
          value="acceleration"
          className="min-h-0 flex-1 overflow-auto"
        >
          <AccelerationTab />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Resources;

export const getStaticProps = makeStaticProperties([
  'common',
  'resources',
  'modelsControl',
  'translateControl',
  'settings',
  'parameters',
]);
export { getStaticPaths };

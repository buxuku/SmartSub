import React from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ModelsTab from '@/components/resources/ModelsTab';
import ProvidersTab from '@/components/resources/ProvidersTab';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

export const RESOURCE_TABS = [
  'overview',
  'models',
  'providers',
  'acceleration',
] as const;
export type ResourceTab = (typeof RESOURCE_TABS)[number];

const Resources = () => {
  const { t } = useTranslation('resources');
  const router = useRouter();
  const queryTab = router.query.tab as string | undefined;
  const activeTab: ResourceTab = (RESOURCE_TABS as readonly string[]).includes(
    queryTab ?? '',
  )
    ? (queryTab as ResourceTab)
    : 'overview';

  const handleTabChange = (value: string) => {
    router.replace(
      { pathname: router.pathname, query: { ...router.query, tab: value } },
      undefined,
      { shallow: true },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>
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
          <p className="text-sm text-muted-foreground">{t('title')}</p>
        </TabsContent>
        <TabsContent value="models" className="min-h-0 flex-1 overflow-auto">
          <ModelsTab />
        </TabsContent>
        <TabsContent value="providers" className="min-h-0 flex-1">
          <ProvidersTab />
        </TabsContent>
        <TabsContent
          value="acceleration"
          className="min-h-0 flex-1 overflow-auto"
        >
          <p className="text-sm text-muted-foreground">
            {t('tab.acceleration')}
          </p>
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

import React from 'react';
import { useTranslation } from 'next-i18next';
import PageHeader from '@/components/PageHeader';
import ProvidersTab from '@/components/resources/ProvidersTab';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 「翻译服务」顶级页（原资源中心 providers Tab 平移为整页）。
 * 翻译服务商的增删改、密钥配置与连通性测试。
 */
const TranslationPage = () => {
  const { t } = useTranslation('common');
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title={t('translationServices')}
        description={t('translationServicesDesc')}
      />
      <div className="min-h-0 flex-1">
        <ProvidersTab />
      </div>
    </div>
  );
};

export default TranslationPage;

export const getStaticProps = makeStaticProperties([
  'common',
  'translateControl',
  'parameters',
]);
export { getStaticPaths };

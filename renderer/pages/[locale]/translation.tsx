import React from 'react';
import ProvidersTab from '@/components/resources/ProvidersTab';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 「翻译服务」顶级页（原资源中心 providers Tab 平移为整页）。
 * 翻译服务商的增删改、密钥配置与连通性测试。
 * 配置页版式：定位由顶栏面包屑与面板标题承担，无页内大标题。
 */
const TranslationPage = () => {
  return (
    <div className="h-full min-h-0 overflow-hidden p-3">
      <ProvidersTab />
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

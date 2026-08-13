import React from 'react';
import ProvidersTab from '@/components/resources/ProvidersTab';
import SummaryPromptPanel from '@/components/resources/SummaryPromptPanel';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 「翻译服务」顶级页：上段服务商管理，下段产品级通读摘要提示词。
 * 配置页版式：定位由顶栏面包屑与面板标题承担，无页内大标题。
 */
const TranslationPage = () => {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 overflow-hidden p-3">
      <div className="min-h-0 flex-1 overflow-hidden">
        <ProvidersTab />
      </div>
      <SummaryPromptPanel />
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

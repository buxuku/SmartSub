import React from 'react';
import ProvidersTab from '@/components/resources/ProvidersTab';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 「翻译服务」顶级页：服务商管理。
 * 通读摘要提示词是低频设置，不常驻页面：在「总览」的「更多设置」与任务配置条的
 * 「生成摘要」弹层里按需打开（见 SummaryPromptDialog）。
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

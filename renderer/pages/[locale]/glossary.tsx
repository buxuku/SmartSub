import React from 'react';
import GlossaryManager from '@/components/glossary/GlossaryManager';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/** 全局翻译词库：独立于任务配置，所有启用词库自动供 AI 翻译与优化读取。 */
const GlossaryPage = () => (
  <div className="h-full min-h-0 overflow-hidden p-3">
    <GlossaryManager />
  </div>
);

export default GlossaryPage;

export const getStaticProps = makeStaticProperties(['common', 'glossary']);
export { getStaticPaths };

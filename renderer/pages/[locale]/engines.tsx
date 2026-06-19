import React from 'react';
import { useTranslation } from 'next-i18next';
import PageHeader from '@/components/PageHeader';
import EngineModelTab from '@/components/resources/EngineModelTab';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 「引擎与模型」顶级页（原资源中心 engines Tab 平移为整页）。
 * 含转写引擎运行时管理、语音模型清单，以及 builtin 的 GPU 加速（见 fold-gpu-into-builtin）。
 */
const EnginesPage = () => {
  const { t } = useTranslation('common');
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader
        title={t('enginesAndModels')}
        description={t('enginesAndModelsDesc')}
      />
      <div className="min-h-0 flex-1">
        <EngineModelTab />
      </div>
    </div>
  );
};

export default EnginesPage;

export const getStaticProps = makeStaticProperties([
  'common',
  'resources',
  'modelsControl',
  'settings',
  'parameters',
]);
export { getStaticPaths };

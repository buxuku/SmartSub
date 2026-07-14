import React from 'react';
import EngineModelTab from '@/components/resources/EngineModelTab';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 「引擎与模型」顶级页（原资源中心 engines Tab 平移为整页）。
 * 含转写引擎运行时管理、语音模型清单，以及 builtin 的 GPU 加速（见 fold-gpu-into-builtin）。
 */
const EnginesPage = () => {
  // 配置页版式：定位由顶栏面包屑与面板标题承担，无页内大标题
  return (
    <div className="h-full min-h-0 overflow-hidden p-3">
      <EngineModelTab />
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

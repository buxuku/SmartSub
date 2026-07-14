import React from 'react';
import TtsServicesTab from '@/components/tts/TtsServicesTab';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 「配音服务」顶级页（形制「引擎与模型」）：本地 TTS 模型 + 在线配音服务商
 * （OpenAI / 硅基流动 / Edge TTS / 自定义端点）逐条目管理。
 * 配置页版式：定位由顶栏面包屑与面板标题承担，无页内大标题。
 */
const TtsServicesPage = () => {
  return (
    <div className="h-full min-h-0 overflow-hidden p-3">
      <TtsServicesTab />
    </div>
  );
};

export default TtsServicesPage;

export const getStaticProps = makeStaticProperties([
  'common',
  'resources',
  'voiceClone',
]);
export { getStaticPaths };

import React from 'react';
import { useTranslation } from 'next-i18next';
import PageHeader from '@/components/PageHeader';
import TtsServicesTab from '@/components/tts/TtsServicesTab';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';

/**
 * 「配音服务」顶级页（形制「引擎与模型」）：本地 TTS 模型 + 在线配音服务商
 * （OpenAI / 硅基流动 / Edge TTS / 自定义端点）逐条目管理。
 */
const TtsServicesPage = () => {
  const { t } = useTranslation('common');
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <PageHeader title={t('ttsServices')} description={t('ttsServicesDesc')} />
      <div className="min-h-0 flex-1">
        <TtsServicesTab />
      </div>
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

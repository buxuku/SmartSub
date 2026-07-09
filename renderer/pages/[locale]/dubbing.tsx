/**
 * 配音工作台页面（薄壳）：字幕 + 可选视频 → 逐条 TTS → 时间轴对齐 → 导出。
 * 支持 `?subtitle=&video=` query 预填（主流程完成横幅衔接）。
 */
import React from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { DubbingPanel } from '@/components/dubbing';
import PageHeader from '@/components/PageHeader';

export default function DubbingPage() {
  const { t } = useTranslation('dubbing');
  const router = useRouter();

  // 等 query 就绪再挂载面板，保证衔接入口的预填参数进入初始状态
  if (!router.isReady) return null;

  const initialSubtitlePath =
    typeof router.query.subtitle === 'string'
      ? router.query.subtitle
      : undefined;
  const initialVideoPath =
    typeof router.query.video === 'string' ? router.query.video : undefined;

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <PageHeader title={t('pageTitle')} description={t('pageDesc')} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <DubbingPanel
          initialSubtitlePath={initialSubtitlePath}
          initialVideoPath={initialVideoPath}
        />
      </div>
    </div>
  );
}

export const getStaticProps = makeStaticProperties([
  'common',
  'dubbing',
  'voiceClone',
]);
export { getStaticPaths };

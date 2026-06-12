/**
 * 视频合并字幕页面
 */

import React from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { SubtitleMergePanel } from '@/components/subtitleMerge';
import PageHeader from '@/components/PageHeader';
import { toast } from 'sonner';

export default function SubtitleMergePage() {
  const { t } = useTranslation('subtitleMerge');
  const router = useRouter();

  const handleComplete = (outputPath: string) => {
    toast.success(t('mergeSuccess'), {
      description: outputPath,
    });
  };

  const handleError = (error: string) => {
    toast.error(t('mergeError'), {
      description: error,
    });
  };

  // 等 query 就绪再挂载面板，保证衔接入口的预填参数能进入初始状态
  if (!router.isReady) return null;

  const initialVideoPath =
    typeof router.query.video === 'string' ? router.query.video : undefined;
  const initialSubtitlePath =
    typeof router.query.subtitle === 'string'
      ? router.query.subtitle
      : undefined;

  return (
    <div className="flex h-full flex-col gap-4 p-4 overflow-hidden">
      <PageHeader title={t('pageTitle')} description={t('pageDesc')} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <SubtitleMergePanel
          initialVideoPath={initialVideoPath}
          initialSubtitlePath={initialSubtitlePath}
          onComplete={handleComplete}
          onError={handleError}
        />
      </div>
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'subtitleMerge']);
export { getStaticPaths };

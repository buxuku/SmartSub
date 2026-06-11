/**
 * 视频合并字幕页面
 */

import React from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { SubtitleMergePanel } from '@/components/subtitleMerge';
import { toast } from 'sonner';

export default function SubtitleMergePage() {
  const { t } = useTranslation('subtitleMerge');
  const router = useRouter();

  const handleComplete = (outputPath: string) => {
    toast.success(t('mergeSuccess') || '视频生成成功', {
      description: outputPath,
    });
  };

  const handleError = (error: string) => {
    toast.error(t('mergeError') || '视频生成失败', {
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
    <div className="h-full p-4 overflow-hidden">
      <SubtitleMergePanel
        initialVideoPath={initialVideoPath}
        initialSubtitlePath={initialSubtitlePath}
        onComplete={handleComplete}
        onError={handleError}
      />
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'subtitleMerge']);
export { getStaticPaths };

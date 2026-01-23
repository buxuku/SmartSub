/**
 * 视频合并字幕页面
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { SubtitleMergePanel } from '@/components/subtitleMerge';
import { toast } from 'sonner';

export default function SubtitleMergePage() {
  const { t } = useTranslation('subtitleMerge');

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

  return (
    <div className="h-full p-4 overflow-hidden">
      <SubtitleMergePanel onComplete={handleComplete} onError={handleError} />
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'subtitleMerge']);
export { getStaticPaths };

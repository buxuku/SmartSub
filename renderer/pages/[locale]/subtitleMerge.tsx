/**
 * 视频合并字幕页面
 */

import React from 'react';
import { useRouter } from 'next/router';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { SubtitleMergePanel } from '@/components/subtitleMerge';

export default function SubtitleMergePage() {
  const router = useRouter();

  // 合成成功/失败均由面板内预览浮层呈现，不再额外弹 toast

  // 等 query 就绪再挂载面板，保证衔接入口的预填参数能进入初始状态
  if (!router.isReady) return null;

  const initialVideoPath =
    typeof router.query.video === 'string' ? router.query.video : undefined;
  const initialSubtitlePath =
    typeof router.query.subtitle === 'string'
      ? router.query.subtitle
      : undefined;

  // 编辑器页版式：无页内大标题（定位由顶栏面包屑承担），内容区直接是工作面板
  return (
    <div className="h-full overflow-hidden p-3">
      <SubtitleMergePanel
        initialVideoPath={initialVideoPath}
        initialSubtitlePath={initialSubtitlePath}
      />
    </div>
  );
}

export const getStaticProps = makeStaticProperties(['common', 'subtitleMerge']);
export { getStaticPaths };

/**
 * 配音工作台页面（薄壳）：字幕 + 可选视频 → 逐条 TTS → 时间轴对齐 → 导出。
 * 支持 `?subtitle=&video=` query 预填（主流程完成横幅衔接），
 * `?session=&workItem=` 为最近任务回开的会话恢复参数。
 */
import React from 'react';
import { useRouter } from 'next/router';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { DubbingPanel } from '@/components/dubbing';

export default function DubbingPage() {
  const router = useRouter();

  // 等 query 就绪再挂载面板，保证衔接入口的预填参数进入初始状态
  if (!router.isReady) return null;

  const queryString = (key: string) =>
    typeof router.query[key] === 'string'
      ? (router.query[key] as string)
      : undefined;
  const initialSubtitlePath = queryString('subtitle');
  const initialVideoPath = queryString('video');
  const initialSessionId = queryString('session');
  const workItemId = queryString('workItem');
  // 检查员模式：配音确认检查点的流水线上下文（切换待检文件时以 key 重挂载面板）
  const gateProject = queryString('gateProject');
  const gateFile = queryString('gateFile');

  // 编辑器页版式：无页内大标题（定位由顶栏面包屑承担），内容区直接是工作面板
  return (
    <div className="h-full overflow-hidden p-3">
      <DubbingPanel
        key={`${initialSessionId ?? ''}:${gateFile ?? ''}`}
        initialSubtitlePath={initialSubtitlePath}
        initialVideoPath={initialVideoPath}
        initialSessionId={initialSessionId}
        workItemId={workItemId}
        gateProject={gateProject}
        gateFile={gateFile}
      />
    </div>
  );
}

export const getStaticProps = makeStaticProperties([
  'common',
  'dubbing',
  'voiceClone',
]);
export { getStaticPaths };

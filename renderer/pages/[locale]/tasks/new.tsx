/**
 * 新建任务向导页（薄壳）：目标驱动的一条龙任务创建。
 * `?recipe=<id>` 按配方预填目标/配置/把关（启动台配方卡入口）；
 * `?preset=full` 为旧入口兼容，预勾全部目标产物。
 */
import React from 'react';
import { useRouter } from 'next/router';
import { getStaticPaths, makeStaticProperties } from '../../../lib/get-static';
import TaskWizard from '@/components/tasks/wizard/TaskWizard';

export default function NewTaskPage() {
  const router = useRouter();
  if (!router.isReady) return null;
  return <TaskWizard />;
}

// home 命名空间为 InlineConfigBar 的历史文案（输出内容/格式下拉等）所需
export const getStaticProps = makeStaticProperties(['common', 'home', 'tasks']);
export { getStaticPaths };

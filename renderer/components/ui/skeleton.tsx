import * as React from 'react';

import { cn } from 'lib/utils';

/**
 * 骨架占位：基于既有 `bg-muted` token + Tailwind `animate-pulse`，无新依赖。
 * 用于「加载中且无缓存数据」时渲染与最终布局同构的占位，避免「居中转圈 + 跳变」。
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}

export { Skeleton };

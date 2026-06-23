import React from 'react';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * 与 `WorkItemList` 行布局同构的骨架占位，用于工程列表加载中（home / recent-tasks），
 * 避免「先闪空态再跳出列表」。纯展示，aria-hidden。
 */
export default function WorkItemRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-lg border divide-y" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <Skeleton className="h-2 w-2 flex-shrink-0 rounded-full" />
          <Skeleton className="h-4 w-1/3 min-w-0 flex-1" />
          <Skeleton className="hidden h-4 w-16 flex-shrink-0 sm:block" />
          <Skeleton className="h-4 w-12 flex-shrink-0" />
          <Skeleton className="hidden h-4 w-16 flex-shrink-0 md:block" />
          <Skeleton className="h-4 w-10 flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

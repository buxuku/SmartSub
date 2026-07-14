import React from 'react';
import { cn } from 'lib/utils';

/**
 * 枢纽页统一头部：大标题 + 可选描述 + 可选右侧操作区。
 * 工作页（任务页/校对编辑器）的「返回 + 上下文标题 + 操作组」模式不使用本组件。
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="space-y-0.5 min-w-0">
        <h1 className="text-lg font-semibold leading-tight tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export default PageHeader;

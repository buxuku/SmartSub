import * as React from 'react';

import { cn } from 'lib/utils';

/**
 * 面板原语：内容区的一级容器（四级层级中的「panel 面板」层）。
 * 页面内容不裸排：任何信息块都装进 Panel，由 PanelHeader 提供 36px 标题行。
 */
const Panel = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <section
      ref={ref}
      className={cn(
        'flex min-h-0 flex-col rounded-lg border bg-card text-card-foreground shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:shadow-none dark:[box-shadow:inset_0_1px_0_rgba(255,255,255,0.03)]',
        className,
      )}
      {...props}
    />
  ),
);
Panel.displayName = 'Panel';

function PanelHeader({
  title,
  meta,
  actions,
  className,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-9 flex-none items-center gap-2 border-b border-border px-3',
        className,
      )}
    >
      <h2 className="min-w-0 truncate text-xs font-bold tracking-wide">
        {title}
      </h2>
      {meta ? (
        <span className="min-w-0 truncate text-[11px] text-faint">{meta}</span>
      ) : null}
      <div className="flex-1" />
      {actions ? (
        <div className="flex flex-none items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}

export { Panel, PanelHeader };

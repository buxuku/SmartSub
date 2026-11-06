import * as React from 'react';

import { cn } from 'lib/utils';

/**
 * 一级内容分区使用中性底面；内部 Card 使用实色面，避免边框层层嵌套。
 */
const Panel = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <section
      ref={ref}
      className={cn(
        'flex min-h-0 flex-col rounded-lg bg-muted/40 text-card-foreground',
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
        'flex h-9 flex-none items-center gap-2 px-3',
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

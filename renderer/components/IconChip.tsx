import React from 'react';
import { cn } from 'lib/utils';

/**
 * 卡片/区块标题左侧的统一图标容器。
 * 收敛此前「裸图标 + mr-2（24px 无约束）」与「图标容器」并存的不一致。
 * 默认中性底（bg-muted），可通过 className 覆盖语义色（如危险区用 destructive）。
 */
export function IconChip({
  icon: Icon,
  className,
  iconClassName,
}: {
  icon: React.ComponentType<{ className?: string }>;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground',
        className,
      )}
    >
      <Icon className={cn('h-4 w-4', iconClassName)} />
    </span>
  );
}

export default IconChip;

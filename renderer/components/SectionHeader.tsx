import React from 'react';
import { cn } from 'lib/utils';

interface SectionHeaderProps {
  /** 左侧图标，统一放入主色圆角容器，保证资源中心各 Tab 头部观感一致 */
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  /** 右侧操作位（按钮、开关、下拉等） */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * 资源中心各 Tab 统一的区块头部：图标容器 + 标题 + 描述 + 右侧操作。
 * 收敛此前每个 Tab 各写一套头部导致的视觉不一致。
 */
const SectionHeader: React.FC<SectionHeaderProps> = ({
  icon: Icon,
  title,
  description,
  actions,
  className,
}) => (
  <div className={cn('flex items-start justify-between gap-3', className)}>
    <div className="flex min-w-0 items-start gap-3">
      {Icon && (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="min-w-0">
        <h2 className="text-lg font-semibold leading-tight">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
    </div>
    {actions && (
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {actions}
      </div>
    )}
  </div>
);

export default SectionHeader;

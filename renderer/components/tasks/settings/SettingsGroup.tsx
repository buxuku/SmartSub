import React from 'react';
import { cn } from 'lib/utils';

/**
 * 「更多设置」里的一组设置：标题 + 分隔线 + 一列设置项。
 * 取代原来细小的全大写小标题：分组是这页的主要导航，标题要读得出来。
 */
export default function SettingsGroup({
  title,
  testId,
  className,
  children,
}: {
  title: string;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={testId} className={cn('space-y-3', className)}>
      <h3 className="border-b pb-1.5 text-xs font-semibold text-foreground">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

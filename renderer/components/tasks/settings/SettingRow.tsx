import React from 'react';
import { FormItem, FormLabel } from '@/components/ui/form';
import ConfigItemHint from '@/components/tasks/ConfigItemHint';
import { cn } from 'lib/utils';

interface SettingRowProps {
  label: React.ReactNode;
  /** 长说明：收进标签旁的 ⓘ 提示，不占版面。 */
  hint?: string;
  /** 标签旁的小标记（如运行库就绪状态、路径说明入口）。 */
  adornment?: React.ReactNode;
  /** 控件放在标签下方而不是右侧：滑块、文本框、命名模板这类要占满一行的控件。 */
  stacked?: boolean;
  /** 仅 `stacked` 时有效：标签行右端的内容，如滑块的当前值。 */
  trailing?: React.ReactNode;
  className?: string;
  testId?: string;
  /** 控件本体，调用方用 `FormControl` 包住它，标签才能指向它。 */
  children: React.ReactNode;
}

/**
 * 一行一个设置项：左边标签（可带 ⓘ），右边控件。面板只有 420px 宽，原来「标签在上、
 * 控件在下、说明在最下」每项占三行，一页长到要不停滚动；改成一行以后，常用页的
 * 前几组在最小窗口里首屏就能看到。必须在 `FormField` 的 `render` 里使用。
 */
export default function SettingRow({
  label,
  hint,
  adornment,
  stacked = false,
  trailing,
  className,
  testId,
  children,
}: SettingRowProps) {
  const heading = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <FormLabel className="min-w-0 text-[13px] font-normal leading-snug">
        {label}
      </FormLabel>
      {adornment}
      {hint && <ConfigItemHint text={hint} testId="setting-hint" />}
    </div>
  );

  return (
    <FormItem className={cn('space-y-0', className)} data-testid={testId}>
      {stacked ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            {heading}
            {trailing}
          </div>
          {children}
        </div>
      ) : (
        <div className="flex min-h-8 items-center justify-between gap-3">
          {heading}
          <div className="flex-none">{children}</div>
        </div>
      )}
    </FormItem>
  );
}

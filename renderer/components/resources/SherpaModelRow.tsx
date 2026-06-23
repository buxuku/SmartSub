import React from 'react';
import { Progress } from '@/components/ui/progress';
import { CheckCircle2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from 'lib/utils';

interface SherpaModelRowProps {
  icon: LucideIcon;
  name: string;
  desc?: string;
  installed?: boolean;
  busy?: boolean;
  progressPercent?: number;
  phaseText?: string;
  progressWidthClass?: string;
  trailing: React.ReactNode;
}

/**
 * FunASR / Qwen 模型清单的统一行：左侧图标+名称+描述+下载进度，右侧动作槽（trailing）。
 * 动作各引擎不同（下载/删除/取消/已安装徽标），由调用方通过 trailing 注入。
 */
const SherpaModelRow: React.FC<SherpaModelRowProps> = ({
  icon: Icon,
  name,
  desc,
  installed,
  busy,
  progressPercent = 0,
  phaseText,
  progressWidthClass = 'w-40',
  trailing,
}) => {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-muted p-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {name}
            {installed && (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
            )}
          </p>
          {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
          {busy && (
            <div className={cn('mt-1.5', progressWidthClass)}>
              <Progress value={progressPercent} />
              {phaseText && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {phaseText}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
};

export default SherpaModelRow;

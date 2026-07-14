import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface StepGuideStep {
  icon: LucideIcon;
  title: string;
  desc: string;
}

/**
 * 统一的空态三步引导（P0 动线统一）：数字圆圈步骤 + 主行动区 + 拖放提示。
 * 任务页 / 配音页 / 合成页 / 校对页的空态共用此形态。
 */
export default function StepGuide({
  steps,
  actions,
  dropHint,
}: {
  steps: StepGuideStep[];
  /** 主行动区（按钮或按钮组） */
  actions?: React.ReactNode;
  dropHint?: string;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="w-full max-w-md space-y-5">
        <div className="space-y-3.5">
          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={i} className="flex items-start gap-3">
                <div className="tnum flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-[13px] font-semibold text-primary">
                  {i + 1}
                </div>
                <div className="min-w-0 space-y-0.5 pt-0.5">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {step.title}
                  </p>
                  <p className="text-xs text-muted-foreground">{step.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
        {(actions || dropHint) && (
          <div className="flex flex-col items-center gap-2">
            {actions}
            {dropHint && (
              <p className="text-xs text-muted-foreground">{dropHint}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

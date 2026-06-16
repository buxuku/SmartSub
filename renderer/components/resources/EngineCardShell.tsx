import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from 'lib/utils';

export interface EngineCardShellProps {
  isActive: boolean;
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  recommended?: boolean;
  recommendedLabel?: string;
  chips: string[];
  desc: string;
  badge: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * 转写引擎卡片外壳（视觉/布局），各引擎共用：
 * 当前引擎高亮 + 左侧色条；标题/推荐徽标/特性 chips/状态徽章 + 描述与自定义 body。
 */
const EngineCardShell: React.FC<EngineCardShellProps> = ({
  isActive,
  icon: Icon,
  name,
  recommended,
  recommendedLabel,
  chips,
  desc,
  badge,
  children,
}) => {
  return (
    <Card
      className={cn(
        'relative overflow-hidden transition-all',
        isActive && 'border-primary/60 bg-primary/[0.03] shadow-sm',
      )}
    >
      {isActive && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-primary"
        />
      )}
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {name}
                {recommended && recommendedLabel && (
                  <Badge
                    variant="outline"
                    className="border-primary/40 px-1.5 py-0 text-[10px] font-medium text-primary"
                  >
                    {recommendedLabel}
                  </Badge>
                )}
              </CardTitle>
              {chips.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {chips.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {badge}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{desc}</p>
        {children}
      </CardContent>
    </Card>
  );
};

export default EngineCardShell;

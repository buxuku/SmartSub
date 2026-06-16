import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Power, Settings2, Check } from 'lucide-react';
import { cn } from 'lib/utils';

export interface EngineWorkbenchCardProps {
  isActive: boolean;
  icon: React.ComponentType<{ className?: string }>;
  name: string;
  recommended?: boolean;
  recommendedLabel?: string;
  chips: string[];
  desc: string;
  scenario?: string;
  badge: React.ReactNode;
  activeLabel: string;
  setActiveLabel: string;
  manageLabel: string;
  canSetActive: boolean;
  setActiveDisabled?: boolean;
  showManage?: boolean;
  onSetActive: () => void;
  onManage: () => void;
}

/** 紧凑「工作台」引擎卡片：一屏看全引擎，操作收敛为 设为当前 / 管理。 */
const EngineWorkbenchCard: React.FC<EngineWorkbenchCardProps> = ({
  isActive,
  icon: Icon,
  name,
  recommended,
  recommendedLabel,
  chips,
  desc,
  scenario,
  badge,
  activeLabel,
  setActiveLabel,
  manageLabel,
  canSetActive,
  setActiveDisabled,
  showManage = true,
  onSetActive,
  onManage,
}) => {
  return (
    <Card
      className={cn(
        'relative flex flex-col overflow-hidden transition-all',
        isActive && 'border-primary/60 bg-primary/[0.03] shadow-sm',
      )}
    >
      {isActive && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 bg-primary"
        />
      )}
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
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
              <p className="flex flex-wrap items-center gap-2 text-base font-semibold leading-tight">
                {name}
                {recommended && recommendedLabel && (
                  <Badge
                    variant="outline"
                    className="border-primary/40 px-1.5 py-0 text-[10px] font-medium text-primary"
                  >
                    {recommendedLabel}
                  </Badge>
                )}
              </p>
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
          <div className="shrink-0">{badge}</div>
        </div>

        <p className="text-sm text-muted-foreground">{desc}</p>
        {scenario && (
          <p className="text-xs font-medium text-muted-foreground/90">
            {scenario}
          </p>
        )}

        <div className="mt-auto flex items-center gap-2 pt-1">
          {isActive ? (
            <Badge className="gap-1">
              <Check className="h-3 w-3" />
              {activeLabel}
            </Badge>
          ) : (
            canSetActive && (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={setActiveDisabled}
                onClick={onSetActive}
              >
                <Power className="h-3.5 w-3.5" />
                {setActiveLabel}
              </Button>
            )
          )}
          {showManage && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={onManage}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {manageLabel}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default EngineWorkbenchCard;

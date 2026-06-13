import React from 'react';
import { HelpCircle } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from 'lib/utils';

/**
 * 可聚焦的帮助提示图标。
 * 替代此前「TooltipTrigger 直接包裸 HelpCircle」的写法——那种写法非 button、
 * 键盘与读屏无法触达。这里用真正的 button 承载，并补 aria-label。
 * 需在祖先存在 TooltipProvider。
 */
export function HelpHint({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={text}
          className={cn(
            'inline-flex rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            className,
          )}
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p className="max-w-[260px]">{text}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export default HelpHint;

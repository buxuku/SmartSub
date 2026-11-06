import React from 'react';
import { Info } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * 标签旁的 ⓘ 提示：说明文字收进悬停/聚焦提示，不占纵向空间。
 * 图标按钮与标签同高（h-4 = text-xs 的行高），出现与否都不会撑高标签行。
 * 按钮的可访问名称就是提示正文，读屏用户无需悬停也能听到。
 *
 * 工具栏（`InlineConfigBar`）与「更多设置」（`SettingRow`）共用；两处各用自己的
 * `testId`，避免面板打开时 e2e 在工具栏里找提示图标会找到面板里的。
 */
export default function ConfigItemHint({
  text,
  testId = 'config-item-hint',
}: {
  text: string;
  testId?: string;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={text}
            data-testid={testId}
            className="inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Info className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-[260px] text-xs leading-relaxed"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

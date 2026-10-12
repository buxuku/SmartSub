import React from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from 'lib/utils';

/**
 * A task entry's file name. A long stem is truncated with an ellipsis but the
 * extension (what tells `a.mp4` from `a.wav`) always stays visible; the full
 * path is one hover away.
 */
export function TaskFileName({
  file,
  className,
}: {
  file: any;
  className?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="task-name"
            className={cn(
              'flex min-w-0 cursor-default items-baseline',
              className,
            )}
          >
            <span className="truncate">{file?.fileName}</span>
            <span data-testid="task-name-ext" className="shrink-0">
              {file?.fileExtension}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-md">
          <p className="break-all">{file?.filePath}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default TaskFileName;

import React from 'react';
import { CircleCheck, Loader, Pause, RedoDot, AlertCircle } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';

const TaskStatus = ({ file, checkKey, skip = false }) => {
  if (skip) return <RedoDot className="size-4" />;

  if (file[checkKey] === 'loading') {
    // 检查是否有进度信息
    const progressKey = `${checkKey}Progress`;
    const hasProgress = file[progressKey] !== undefined;
    return (
      <div className="flex items-center gap-1">
        <Loader className="animate-spin size-4" />
        {hasProgress && (
          <span className="text-xs">{file[progressKey].toFixed(2)}%</span>
        )}
      </div>
    );
  }

  if (file[checkKey] === 'done') {
    return <CircleCheck className="size-4" />;
  }

  if (file[checkKey] === 'error') {
    const errorKey = `${checkKey}Error`;
    const errorMsg = file[errorKey] || '未知错误';

    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertCircle className="size-4 text-red-500" />
          </TooltipTrigger>
          <TooltipContent>
            <p>{errorMsg}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return <Pause className="size-4" />;
};

export default TaskStatus;

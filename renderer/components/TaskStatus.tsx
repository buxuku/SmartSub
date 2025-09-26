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

  // 状态调试：检查进度与状态的一致性
  const progressKey = `${checkKey}Progress`;
  const progress = file[progressKey];
  const status = file[checkKey];

  // 调试日志（仅在开发环境）
  if (process.env.NODE_ENV === 'development') {
    // 检查状态不一致的情况
    if (status === 'done' && progress !== undefined && progress < 100) {
      console.warn(`状态不一致: ${checkKey} 状态为 done 但进度为 ${progress}%`);
    }
    if (status === 'loading' && progress === undefined) {
      console.warn(`状态不一致: ${checkKey} 状态为 loading 但没有进度信息`);
    }
  }

  if (status === 'loading') {
    // 检查是否有进度信息
    const hasProgress = progress !== undefined && progress !== null;
    const displayProgress = hasProgress ? Number(progress).toFixed(2) : '0.00';

    return (
      <div className="flex items-center gap-1">
        <Loader className="animate-spin size-4" />
        <span className="text-xs">{displayProgress}%</span>
      </div>
    );
  }

  if (status === 'done') {
    return <CircleCheck className="size-4" />;
  }

  if (status === 'error') {
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
            {progress !== undefined && (
              <p className="text-xs text-gray-500 mt-1">进度：{progress}%</p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return <Pause className="size-4" />;
};

export default TaskStatus;

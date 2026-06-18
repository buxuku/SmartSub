import React from 'react';
import { cn } from 'lib/utils';

export interface DownloadSourceOption<T extends string = string> {
  value: T;
  label: string;
}

interface DownloadSourceSelectorProps<T extends string = string> {
  label: string;
  value: T;
  options: DownloadSourceOption<T>[];
  onChange: (value: T) => void;
  hint?: string;
  className?: string;
}

/**
 * 统一的「下载源」选择器：按钮组形态 + 无障碍 radiogroup 语义。
 * 各引擎/模型的下载源选择共用此组件，保证视觉、交互、可访问性一致。
 */
function DownloadSourceSelector<T extends string = string>({
  label,
  value,
  options,
  onChange,
  hint,
  className,
}: DownloadSourceSelectorProps<T>) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex gap-2">
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={cn(
                'flex-1 rounded-md border px-3 py-2 text-xs transition-all',
                selected
                  ? 'border-primary bg-primary/5 font-medium'
                  : 'border-muted hover:border-primary/50',
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default DownloadSourceSelector;

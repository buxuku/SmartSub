/**
 * 对齐位置选择器组件
 * 9宫格形式选择字幕位置
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import type { SubtitleAlignment } from '../../../types/subtitleMerge';

interface AlignmentSelectorProps {
  value: SubtitleAlignment;
  onChange: (value: SubtitleAlignment) => void;
  disabled?: boolean;
}

// 对齐位置映射 (ASS 标准)
// 7 8 9  顶部
// 4 5 6  中间
// 1 2 3  底部
const ALIGNMENT_GRID: SubtitleAlignment[][] = [
  [7, 8, 9], // 顶部行
  [4, 5, 6], // 中间行
  [1, 2, 3], // 底部行
];

const ALIGNMENT_LABELS: Record<SubtitleAlignment, string> = {
  1: '左下',
  2: '中下',
  3: '右下',
  4: '左中',
  5: '居中',
  6: '右中',
  7: '左上',
  8: '中上',
  9: '右上',
};

export default function AlignmentSelector({
  value,
  onChange,
  disabled = false,
}: AlignmentSelectorProps) {
  const { t } = useTranslation('subtitleMerge');

  return (
    <div className="inline-grid grid-cols-3 gap-1 p-1 bg-muted rounded-lg">
      {ALIGNMENT_GRID.map((row, rowIndex) => (
        <React.Fragment key={rowIndex}>
          {row.map((alignment) => (
            <button
              key={alignment}
              type="button"
              onClick={() => onChange(alignment)}
              disabled={disabled}
              title={t(`align${alignment}`) || ALIGNMENT_LABELS[alignment]}
              className={`
                w-8 h-8 rounded flex items-center justify-center text-xs font-medium
                transition-colors
                ${
                  value === alignment
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-accent'
                }
                ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              {/* 使用小圆点指示位置 */}
              <span
                className={`w-2 h-2 rounded-full ${
                  value === alignment
                    ? 'bg-primary-foreground'
                    : 'bg-muted-foreground'
                }`}
              />
            </button>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

/**
 * 字幕预览叠加层组件
 * 使用 CSS 模拟字幕效果
 */

import React from 'react';
import type { SubtitleStyle } from '../../../types/subtitleMerge';
import {
  subtitleStyleToCSS,
  getSubtitleContainerStyle,
} from './utils/styleUtils';

interface SubtitlePreviewOverlayProps {
  style: SubtitleStyle;
  text: string;
}

export default function SubtitlePreviewOverlay({
  style,
  text,
}: SubtitlePreviewOverlayProps) {
  const containerStyle = getSubtitleContainerStyle(style, 0, 0);
  const textStyle = subtitleStyleToCSS(style);

  return (
    <div className="absolute inset-0 pointer-events-none">
      <div style={containerStyle}>
        <span style={textStyle}>{text}</span>
      </div>
    </div>
  );
}

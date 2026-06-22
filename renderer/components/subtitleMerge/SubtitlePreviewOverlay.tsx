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
  /** 预览盒缩放系数（盒高/333），用于让 CSS 模拟字号≈烧录后字号 */
  scale?: number;
}

export default function SubtitlePreviewOverlay({
  style,
  text,
  scale = 1,
}: SubtitlePreviewOverlayProps) {
  const containerStyle = getSubtitleContainerStyle(style, 0, 0, scale);
  const textStyle = subtitleStyleToCSS(style, scale);

  return (
    <div className="absolute inset-0 pointer-events-none">
      <div style={containerStyle}>
        <span style={textStyle}>{text}</span>
      </div>
    </div>
  );
}

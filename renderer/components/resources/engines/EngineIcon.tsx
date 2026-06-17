import React from 'react';
import type { TranscriptionEngine } from '../../../../types/engine';

interface EngineIconProps {
  engine: TranscriptionEngine;
  className?: string;
}

/**
 * 各转写引擎的品牌化图标。优先用能代表该引擎特性的彩色标记，
 * 而非通用单色图标，便于在引擎列表里一眼区分：
 * - builtin（whisper.cpp，内置本地）：芯片内的声波
 * - fasterWhisper（主打速度）：闪电
 * - funasr（阿里达摩院）：橙色声波（语音识别）
 * - localCli（本地命令行）：终端提示符
 */
const EngineIcon: React.FC<EngineIconProps> = ({ engine, className }) => {
  if (engine === 'fasterWhisper') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M13 2.5 5 13.5h5.5L9.5 21.5 18 9.5h-5.5L13 2.5Z"
          fill="#F59E0B"
        />
      </svg>
    );
  }
  if (engine === 'funasr') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        aria-hidden="true"
      >
        <circle cx="6.5" cy="12" r="2" fill="#FF6A00" />
        <g stroke="#FF6A00" strokeWidth={1.9} strokeLinecap="round" fill="none">
          <path d="M11 8.5a5 5 0 0 1 0 7" />
          <path d="M14.5 5.5a10 10 0 0 1 0 13" />
        </g>
      </svg>
    );
  }
  if (engine === 'localCli') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        aria-hidden="true"
      >
        <rect
          x="2.5"
          y="4.5"
          width="19"
          height="15"
          rx="3"
          fill="#10B981"
          fillOpacity={0.14}
        />
        <g
          stroke="#10B981"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M7 10l2.5 2.5L7 15" />
          <path d="M12.5 15.5H17" />
        </g>
      </svg>
    );
  }
  // builtin（whisper.cpp）
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="2.5"
        y="5"
        width="19"
        height="14"
        rx="3.5"
        fill="#6366F1"
        fillOpacity={0.14}
      />
      <g stroke="#6366F1" strokeWidth={1.7} strokeLinecap="round">
        <path d="M7 10.5v3" />
        <path d="M10 8.5v7" />
        <path d="M13 7.5v9" />
        <path d="M16 10v4" />
      </g>
    </svg>
  );
};

export default EngineIcon;

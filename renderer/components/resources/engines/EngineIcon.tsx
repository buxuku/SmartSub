import React from 'react';
import type { TranscriptionEngine } from '../../../../types/engine';

interface EngineIconProps {
  /** 真实引擎 id，或合并展示组 'sherpa'（FunASR · Qwen · FireRed）。 */
  engine: TranscriptionEngine | 'sherpa';
  className?: string;
}

/**
 * 各转写引擎的品牌化图标。优先用能代表该引擎特性的彩色标记，
 * 而非通用单色图标，便于在引擎列表里一眼区分：
 * - builtin（whisper.cpp，内置本地）：芯片内的声波
 * - fasterWhisper（主打速度）：闪电
 * - funasr（阿里达摩院）：橙色声波（语音识别）
 * - sherpa（FunASR · Qwen · FireRed 合并组）：堆叠的声波层，示意「多模型共用一套运行库」
 * - localCli（本地命令行）：终端提示符
 */
const EngineIcon: React.FC<EngineIconProps> = ({ engine, className }) => {
  if (engine === 'sherpa') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" fill="#0EA5E9" fillOpacity={0.14} />
        <g stroke="#0EA5E9" strokeWidth={1.7} strokeLinecap="round" fill="none">
          <path d="M6.5 12v0.5" />
          <path d="M9 9.5v5" />
          <path d="M12 7.5v9" />
          <path d="M15 9.5v5" />
          <path d="M17.5 11v2" />
        </g>
      </svg>
    );
  }
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
  if (engine === 'qwen') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" fill="#7C3AED" fillOpacity={0.14} />
        <g stroke="#7C3AED" strokeWidth={1.8} strokeLinecap="round" fill="none">
          <path d="M8 12v0.5" />
          <path d="M10.5 9.5v5" />
          <path d="M13.5 8v8" />
          <path d="M16 10.5v3" />
        </g>
      </svg>
    );
  }
  if (engine === 'fireRedAsr') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12 2.5c1.8 2.4 1.2 4.3-.2 5.8-1.5 1.6-3.6 3.2-3.6 6.1A4.3 4.3 0 0 0 12 18.7a4.3 4.3 0 0 0 3.8-4.3c0-1.3-.5-2.4-1.1-3.4.9.4 1.7 1.1 2.2 2.2.7 1.4.8 3.2-.2 5 1.7-1 2.8-2.9 2.8-5.4 0-3.7-2.9-6.4-3.8-9.6-1.1 1-1.6 2.2-1.5 3.6-1.4-1.4-2-3.4-.2-5.9Z"
          fill="#FF2442"
        />
      </svg>
    );
  }
  if (engine === 'cloud') {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M7 18h9.5a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.2 9.6 3.7 3.7 0 0 0 7 18Z"
          fill="#0EA5E9"
          fillOpacity={0.16}
          stroke="#0EA5E9"
          strokeWidth={1.4}
        />
        <g stroke="#0EA5E9" strokeWidth={1.6} strokeLinecap="round" fill="none">
          <path d="M10 12.5v2" />
          <path d="M12 11v5" />
          <path d="M14 12.5v2" />
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

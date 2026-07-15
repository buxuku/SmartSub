/**
 * 文件选择器组件
 * 用于选择视频和字幕文件 - 紧凑版
 */

import React from 'react';
import path from 'path';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Video, FileText, AudioLines, X } from 'lucide-react';
import type { VideoInfo, SubtitleInfo } from '../../../types/subtitleMerge';
import { formatDuration } from './utils/styleUtils';

interface FileSelectorProps {
  videoPath: string | null;
  subtitlePath: string | null;
  videoInfo: VideoInfo | null;
  subtitleInfo: SubtitleInfo | null;
  /** 可选配音音轨（合成矩阵音轨维度） */
  audioTrackPath?: string | null;
  onSelectVideo: () => void;
  onSelectSubtitle: () => void;
  onSelectAudioTrack?: () => void;
  onClearVideo?: () => void;
  onClearSubtitle?: () => void;
  onClearAudioTrack?: () => void;
  disabled?: boolean;
}

export default function FileSelector({
  videoPath,
  subtitlePath,
  videoInfo,
  subtitleInfo,
  audioTrackPath = null,
  onSelectVideo,
  onSelectSubtitle,
  onSelectAudioTrack,
  onClearVideo,
  onClearSubtitle,
  onClearAudioTrack,
  disabled = false,
}: FileSelectorProps) {
  const { t } = useTranslation('subtitleMerge');

  /** 紧凑文件槽：30px 高，选中态绿点 + 元信息（NLE 文件条规范） */
  const slot = (opts: {
    filled: boolean;
    icon: React.ReactNode;
    name: React.ReactNode;
    meta: React.ReactNode;
    placeholder: string;
    title?: string;
    onClick?: () => void;
    onClear?: () => void;
    grow: string;
  }) => (
    <div
      className={`flex h-[30px] min-w-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 transition-colors hover:border-primary/60 ${
        opts.filled
          ? 'border-success/35 bg-success/[0.05]'
          : 'border-border bg-panel-2'
      } ${disabled ? 'pointer-events-none opacity-60' : ''} ${opts.grow}`}
      onClick={!disabled ? opts.onClick : undefined}
      title={opts.title}
    >
      <span
        className={`flex-none ${opts.filled ? 'text-success' : 'text-faint'}`}
      >
        {opts.icon}
      </span>
      {opts.filled ? (
        <>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {opts.name}
          </span>
          <span className="tnum flex-none whitespace-nowrap text-[11px] text-faint">
            {opts.meta}
          </span>
          {opts.onClear && (
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 flex-none"
              onClick={(e) => {
                e.stopPropagation();
                opts.onClear?.();
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </>
      ) : (
        <span className="truncate text-xs text-faint">{opts.placeholder}</span>
      )}
    </div>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row">
      {slot({
        filled: Boolean(videoPath),
        icon: <Video className="h-3.5 w-3.5" />,
        name: videoPath
          ? videoInfo?.fileName || path.basename(videoPath)
          : null,
        meta: videoInfo ? formatDuration(videoInfo.duration) : null,
        placeholder: t('clickToSelectVideo'),
        title: videoPath || undefined,
        onClick: onSelectVideo,
        onClear: videoPath ? onClearVideo : undefined,
        grow: 'sm:flex-[1.3]',
      })}
      {slot({
        filled: Boolean(subtitlePath),
        icon: <FileText className="h-3.5 w-3.5" />,
        name: subtitlePath
          ? subtitleInfo?.fileName || path.basename(subtitlePath)
          : null,
        meta: subtitleInfo
          ? `${subtitleInfo.count} ${t('subtitleCount')}`
          : null,
        placeholder: t('clickToSelectSubtitle'),
        title: subtitlePath || undefined,
        onClick: onSelectSubtitle,
        onClear: subtitlePath ? onClearSubtitle : undefined,
        grow: 'sm:flex-1',
      })}
      {onSelectAudioTrack &&
        slot({
          filled: Boolean(audioTrackPath),
          icon: <AudioLines className="h-3.5 w-3.5" />,
          name: audioTrackPath ? path.basename(audioTrackPath) : null,
          meta: audioTrackPath ? t('audioTrackFilled') : null,
          placeholder: t('clickToSelectAudioTrack'),
          title: audioTrackPath || undefined,
          onClick: onSelectAudioTrack,
          onClear: audioTrackPath ? onClearAudioTrack : undefined,
          grow: 'sm:flex-1',
        })}
    </div>
  );
}

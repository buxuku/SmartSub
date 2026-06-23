/**
 * 文件选择器组件
 * 用于选择视频和字幕文件 - 紧凑版
 */

import React from 'react';
import path from 'path';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Video, FileText, X } from 'lucide-react';
import type { VideoInfo, SubtitleInfo } from '../../../types/subtitleMerge';
import { formatDuration } from './utils/styleUtils';

interface FileSelectorProps {
  videoPath: string | null;
  subtitlePath: string | null;
  videoInfo: VideoInfo | null;
  subtitleInfo: SubtitleInfo | null;
  onSelectVideo: () => void;
  onSelectSubtitle: () => void;
  onClearVideo?: () => void;
  onClearSubtitle?: () => void;
  disabled?: boolean;
}

export default function FileSelector({
  videoPath,
  subtitlePath,
  videoInfo,
  subtitleInfo,
  onSelectVideo,
  onSelectSubtitle,
  onClearVideo,
  onClearSubtitle,
  disabled = false,
}: FileSelectorProps) {
  const { t } = useTranslation('subtitleMerge');

  return (
    <div className="flex flex-col sm:flex-row gap-2">
      {/* 视频文件选择 */}
      <div
        className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border transition-all cursor-pointer hover:border-primary ${
          videoPath
            ? 'border-success bg-success/10'
            : 'border-border bg-muted/30'
        } ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
        onClick={!disabled ? onSelectVideo : undefined}
      >
        <div
          className={`p-1.5 rounded ${
            videoPath
              ? 'bg-success/15 text-success'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          <Video className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          {videoPath ? (
            <div className="flex items-center gap-2">
              <span className="text-sm truncate flex-1" title={videoPath}>
                {videoInfo?.fileName || path.basename(videoPath)}
              </span>
              {videoInfo && (
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDuration(videoInfo.duration)}
                </span>
              )}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">
              {t('clickToSelectVideo')}
            </span>
          )}
        </div>
        {videoPath && onClearVideo && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onClearVideo();
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>

      {/* 字幕文件选择 */}
      <div
        className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border transition-all cursor-pointer hover:border-primary ${
          subtitlePath
            ? 'border-success bg-success/10'
            : 'border-border bg-muted/30'
        } ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
        onClick={!disabled ? onSelectSubtitle : undefined}
      >
        <div
          className={`p-1.5 rounded ${
            subtitlePath
              ? 'bg-success/15 text-success'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          <FileText className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          {subtitlePath ? (
            <div className="flex items-center gap-2">
              <span className="text-sm truncate flex-1" title={subtitlePath}>
                {subtitleInfo?.fileName || path.basename(subtitlePath)}
              </span>
              {subtitleInfo && (
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {subtitleInfo.count} {t('subtitleCount')}
                </span>
              )}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">
              {t('clickToSelectSubtitle')}
            </span>
          )}
        </div>
        {subtitlePath && onClearSubtitle && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onClearSubtitle();
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

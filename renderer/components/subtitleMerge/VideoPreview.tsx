/**
 * 视频预览组件
 * 16:9 比例显示视频和字幕效果
 */

import React, { useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import ReactPlayer from 'react-player';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Play, Pause } from 'lucide-react';
import type { SubtitleStyle, VideoInfo } from '../../../types/subtitleMerge';
import SubtitlePreviewOverlay from './SubtitlePreviewOverlay';
import { formatTime } from '../../hooks/useVideoPlayer';

interface VideoPreviewProps {
  videoPath: string | null;
  videoInfo: VideoInfo | null;
  style: SubtitleStyle;
  sampleText?: string;
}

export default function VideoPreview({
  videoPath,
  videoInfo,
  style,
  sampleText = '这是字幕预览效果\nThis is subtitle preview',
}: VideoPreviewProps) {
  const { t } = useTranslation('subtitleMerge');
  const playerRef = useRef<ReactPlayer>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // 处理进度更新
  const handleProgress = ({ playedSeconds }: { playedSeconds: number }) => {
    setCurrentTime(playedSeconds);
  };

  // 处理时长获取
  const handleDuration = (dur: number) => {
    setDuration(dur);
  };

  // 跳转到指定时间
  const handleSeek = (value: number[]) => {
    const time = value[0];
    setCurrentTime(time);
    playerRef.current?.seekTo(time, 'seconds');
  };

  return (
    <div className="space-y-2">
      {/* 预览区域 - 16:9 */}
      <div
        className="relative w-full bg-black rounded-lg overflow-hidden"
        style={{ paddingBottom: '56.25%' }} // 16:9 比例
      >
        <div className="absolute inset-0 flex items-center justify-center">
          {videoPath ? (
            <>
              {/* 视频播放器 */}
              <ReactPlayer
                ref={playerRef}
                url={`media://${encodeURIComponent(videoPath)}`}
                width="100%"
                height="100%"
                playing={isPlaying}
                controls={false}
                onProgress={handleProgress}
                onDuration={handleDuration}
                progressInterval={100}
                style={{ position: 'absolute', top: 0, left: 0 }}
              />

              {/* CSS 模拟字幕叠加层 */}
              <SubtitlePreviewOverlay style={style} text={sampleText} />
            </>
          ) : (
            <div className="text-muted-foreground text-center">
              <p className="text-sm">
                {t('selectVideoToPreview') || '请选择视频文件预览'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 播放控制 */}
      {videoPath && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setIsPlaying(!isPlaying)}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </Button>
          <span className="text-xs text-muted-foreground w-10">
            {formatTime(currentTime)}
          </span>
          <Slider
            value={[currentTime]}
            min={0}
            max={duration || 100}
            step={0.1}
            onValueChange={handleSeek}
            className="flex-1"
          />
          <span className="text-xs text-muted-foreground w-10 text-right">
            {formatTime(duration)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 视频预览组件
 * 16:9 比例显示视频和字幕效果
 */

import React, { useEffect, useRef, useState } from 'react';
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
  subtitlePath?: string | null;
  sampleText?: string;
}

interface PreviewCue {
  startSec: number;
  endSec: number;
  text: string;
}

// SRT 时间 "HH:MM:SS,mmm" → 秒
const srtTimeToSeconds = (time: string): number => {
  const match = time.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return NaN;
  const [, h, m, s, ms] = match;
  return (
    Number(h) * 3600 +
    Number(m) * 60 +
    Number(s) +
    Number(ms.padEnd(3, '0')) / 1000
  );
};

// 二分查找当前时间所在条目：最后一个 startSec <= t 的候选，再验 endSec
const findCueAtTime = (cues: PreviewCue[], time: number): PreviewCue | null => {
  let lo = 0;
  let hi = cues.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].startSec <= time) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate === -1) return null;
  return cues[candidate].endSec > time ? cues[candidate] : null;
};

export default function VideoPreview({
  videoPath,
  videoInfo,
  style,
  subtitlePath = null,
  sampleText = '这是字幕预览效果\nThis is subtitle preview',
}: VideoPreviewProps) {
  const { t } = useTranslation('subtitleMerge');
  const playerRef = useRef<ReactPlayer>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [cues, setCues] = useState<PreviewCue[]>([]);

  // 选中字幕文件后解析真实条目（清除则回退样例文字）
  useEffect(() => {
    if (!subtitlePath) {
      setCues([]);
      return;
    }
    let stale = false;
    (async () => {
      try {
        const entries: Array<{ startEndTime: string; content: string[] }> =
          await window.ipc.invoke('readSubtitleFile', {
            filePath: subtitlePath,
          });
        if (stale) return;
        const parsed = (entries || [])
          .map((entry) => {
            const [start, end] = (entry.startEndTime || '').split('-->');
            return {
              startSec: srtTimeToSeconds(start || ''),
              endSec: srtTimeToSeconds(end || ''),
              text: (entry.content || []).join('\n'),
            };
          })
          .filter(
            (cue) =>
              Number.isFinite(cue.startSec) &&
              Number.isFinite(cue.endSec) &&
              cue.text.trim() !== '',
          );
        setCues(parsed);
      } catch (error) {
        console.error('解析预览字幕失败:', error);
        if (!stale) setCues([]);
      }
    })();
    return () => {
      stale = true;
    };
  }, [subtitlePath]);

  // 叠加层文字：有字幕文件时所见即所得（空档期不显示），否则用样例文字调样式
  const currentCue = cues.length > 0 ? findCueAtTime(cues, currentTime) : null;
  const overlayText =
    subtitlePath && cues.length > 0 ? (currentCue?.text ?? null) : sampleText;

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

              {/* CSS 模拟字幕叠加层（真实条目优先，未选字幕时显示样例） */}
              {overlayText !== null && (
                <SubtitlePreviewOverlay style={style} text={overlayText} />
              )}
            </>
          ) : (
            <div className="text-muted-foreground text-center">
              <p className="text-sm">{t('selectVideoToPreview')}</p>
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

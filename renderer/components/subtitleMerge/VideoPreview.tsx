/**
 * 视频预览组件
 * 按真实视频比例显示视频和字幕效果；使用原生播放控制条，处理状态以浮层呈现
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import ReactPlayer from 'react-player';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Loader2, CheckCircle, XCircle, Folder } from 'lucide-react';
import type {
  SubtitleStyle,
  VideoInfo,
  MergeProgress,
  MergeStatus,
} from '../../../types/subtitleMerge';
import SubtitlePreviewOverlay from './SubtitlePreviewOverlay';
import { LIBASS_SRT_PLAYRES_Y, formatDuration } from './utils/styleUtils';
import { useJassubPreview } from './hooks/useJassubPreview';

/** 迷你时间轴最多渲染的字幕块数：超出时相邻合并，避免超长字幕列表拖慢渲染 */
const MAX_TIMELINE_BLOCKS = 600;

interface VideoPreviewProps {
  videoPath: string | null;
  videoInfo: VideoInfo | null;
  style: SubtitleStyle;
  subtitlePath?: string | null;
  sampleText?: string;
  /** 合成进度（用于处理中/错误浮层） */
  progress?: MergeProgress;
  /** 合成状态（驱动浮层显隐） */
  status?: MergeStatus;
  /** 取消中标记 */
  isCancelling?: boolean;
  /** 取消合成 */
  onCancelMerge?: () => void;
  /** 打开输出文件夹 */
  onOpenOutputFolder?: () => void;
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
  sampleText = '字幕预览效果',
  progress,
  status = 'idle',
  isCancelling = false,
  onCancelMerge,
  onOpenOutputFolder,
}: VideoPreviewProps) {
  const { t } = useTranslation('subtitleMerge');
  const playerRef = useRef<ReactPlayer>(null);
  const previewAreaRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [cues, setCues] = useState<PreviewCue[]>([]);
  // 底层 <video> 元素（ReactPlayer onReady 后可取），供 JASSUB 预览引擎挂载
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  // 预览框尺寸：按可视区宽高拟合最大矩形，保证完整可见且不撑出滚动条
  const [box, setBox] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  // 预览盒宽高比：优先用真实视频比例（非 16:9 视频也能所见即所得），否则回退 16:9
  const aspect =
    videoInfo && videoInfo.width > 0 && videoInfo.height > 0
      ? videoInfo.width / videoInfo.height
      : 16 / 9;

  // 监听预览区尺寸变化，重算最大可容纳的盒子（取按宽/按高撑满中较小者）
  useEffect(() => {
    const el = previewAreaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const compute = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0 || h <= 0) return;
      let width = w;
      let height = w / aspect;
      if (height > h) {
        height = h;
        width = h * aspect;
      }
      setBox({ width, height });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

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

  // JASSUB（libass WASM）预览引擎：与烧录消费同一份生成的 ASS 内容，所见即所得。
  // 引擎就绪前/初始化失败时回退下方 CSS 模拟叠加层。
  const jassub = useJassubPreview({
    videoEl,
    subtitlePath,
    sampleText,
    style,
  });

  // 叠加层文字：有字幕文件时所见即所得（空档期不显示），否则用样例文字调样式
  const currentCue = cues.length > 0 ? findCueAtTime(cues, currentTime) : null;
  const overlayText =
    subtitlePath && cues.length > 0 ? (currentCue?.text ?? null) : sampleText;

  // 处理进度更新（原生控制条拖动同样会触发，保证字幕叠加层同步）
  const handleProgress = ({ playedSeconds }: { playedSeconds: number }) => {
    setCurrentTime(playedSeconds);
  };

  const isProcessing = status === 'processing';

  // ── 迷你时间轴：字幕块在片中的分布（只读展示 + 点击 seek）────────────
  const duration = videoInfo?.duration || 0;
  const timelineLaneRef = useRef<HTMLDivElement>(null);

  // 超长字幕列表按步长合并相邻条目，控制 DOM 数量
  const timelineBlocks = useMemo(() => {
    if (!cues.length || duration <= 0) return [];
    const step = Math.max(1, Math.ceil(cues.length / MAX_TIMELINE_BLOCKS));
    const blocks: Array<{ left: number; width: number; active: boolean }> = [];
    for (let i = 0; i < cues.length; i += step) {
      const start = cues[i].startSec;
      const end = cues[Math.min(i + step - 1, cues.length - 1)].endSec;
      if (!(end > start)) continue;
      blocks.push({
        left: (start / duration) * 100,
        width: Math.max(((end - start) / duration) * 100, 0.35),
        active: currentTime >= start && currentTime < end,
      });
    }
    return blocks;
  }, [cues, duration, currentTime]);

  const timelineTicks = useMemo(() => {
    if (duration <= 0) return [];
    const segments = 6;
    return Array.from({ length: segments }, (_, i) =>
      formatDuration((duration / segments) * i),
    );
  }, [duration]);

  const seekFromTimeline = (e: React.MouseEvent) => {
    const lane = timelineLaneRef.current;
    if (!lane || duration <= 0) return;
    const rect = lane.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(
      Math.max((e.clientX - rect.left) / rect.width, 0),
      1,
    );
    const target = ratio * duration;
    playerRef.current?.seekTo(target, 'seconds');
    setCurrentTime(target);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 预览区域 - 自适应高度，保持真实比例完整可见 */}
      <div
        ref={previewAreaRef}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      >
        <div
          className="relative bg-black rounded-lg overflow-hidden"
          style={
            box.width > 0
              ? { width: box.width, height: box.height }
              : { width: '100%', aspectRatio: String(aspect) }
          }
        >
          <div className="absolute inset-0 flex items-center justify-center">
            {videoPath ? (
              <>
                {/* 视频播放器：原生控制条 */}
                <ReactPlayer
                  ref={playerRef}
                  url={`media://${encodeURIComponent(videoPath)}`}
                  width="100%"
                  height="100%"
                  playing={isPlaying}
                  controls={true}
                  onReady={() => {
                    const internal = playerRef.current?.getInternalPlayer();
                    if (internal instanceof HTMLVideoElement) {
                      setVideoEl(internal);
                    }
                  }}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onProgress={handleProgress}
                  progressInterval={100}
                  style={{ position: 'absolute', top: 0, left: 0 }}
                />

                {/* CSS 模拟字幕叠加层（降级方案）：仅在 JASSUB 引擎未接管时显示。
                  scale=盒高/333：让预览字号随预览框大小等比缩放，≈烧录后字号 */}
                {!jassub.active && overlayText !== null && (
                  <SubtitlePreviewOverlay
                    style={style}
                    text={overlayText}
                    scale={
                      box.height > 0 ? box.height / LIBASS_SRT_PLAYRES_Y : 1
                    }
                  />
                )}
              </>
            ) : (
              <div className="text-muted-foreground text-center">
                <p className="text-sm">{t('selectVideoToPreview')}</p>
              </div>
            )}
          </div>

          {/* 处理中浮层：不撑高布局，居中半透明面板 + 进度 + 取消 */}
          {isProcessing && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-sm">
              <Loader2 className="h-8 w-8 animate-spin text-white" />
              <div className="w-2/3 max-w-xs space-y-1.5">
                <div className="flex items-center justify-between text-xs text-white/90">
                  <span>{t('processing')}</span>
                  <span className="font-medium">
                    {Math.round(progress?.percent ?? 0)}%
                  </span>
                </div>
                <Progress value={progress?.percent ?? 0} className="h-1.5" />
                {progress?.timeMark && (
                  <p className="text-[11px] text-white/70">
                    {t('currentTime')}: {progress.timeMark}
                  </p>
                )}
              </div>
              {onCancelMerge && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={onCancelMerge}
                  disabled={isCancelling}
                >
                  <XCircle className="mr-1 h-3 w-3" />
                  {isCancelling ? t('cancelling') : t('cancel')}
                </Button>
              )}
            </div>
          )}

          {/* 成功浮层：右上角卡片，不全遮挡画面 */}
          {status === 'completed' && (
            <div className="absolute right-2 top-2 z-20 flex items-center gap-2 rounded-lg border border-success/40 bg-background/95 px-3 py-2 shadow-lg">
              <CheckCircle className="h-4 w-4 text-success" />
              <span className="text-xs text-success">{t('mergeSuccess')}</span>
              {onOpenOutputFolder && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={onOpenOutputFolder}
                >
                  <Folder className="mr-1 h-3 w-3" />
                  {t('openFolder')}
                </Button>
              )}
            </div>
          )}

          {/* 错误浮层：底部条 */}
          {status === 'error' && progress?.errorMessage && (
            <div className="absolute inset-x-2 bottom-2 z-20 flex items-start gap-2 rounded-lg border border-destructive/40 bg-background/95 px-3 py-2 shadow-lg">
              <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-destructive">
                  {t('mergeError')}
                </p>
                <p className="mt-0.5 break-all text-[11px] text-destructive">
                  {progress.errorMessage}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 迷你时间轴：V1 视频轨 + S1 字幕块分布，点击任意处 seek */}
      {videoPath && duration > 0 && (
        <div className="mt-2 flex flex-none select-none overflow-hidden rounded-md border border-border bg-panel-2">
          {/* 轨道标签列 */}
          <div className="flex w-14 flex-none flex-col border-r border-border text-[10px] tracking-wide text-faint">
            <span className="flex h-4 items-center border-b border-border pl-2" />
            <span className="flex h-[22px] items-center border-b border-border pl-2">
              {t('timelineVideoTrack')}
            </span>
            <span className="flex h-[22px] items-center pl-2">
              {t('timelineSubtitleTrack')}
            </span>
          </div>
          {/* 刻度 + 轨道 + 播放头 */}
          <div
            ref={timelineLaneRef}
            className="relative min-w-0 flex-1 cursor-pointer"
            onClick={seekFromTimeline}
          >
            <div className="tnum flex h-4 border-b border-border text-[10px] leading-4 text-faint">
              {timelineTicks.map((tick, i) => (
                <span
                  key={i}
                  className="tnum flex-1 truncate border-l border-border/60 pl-1 first:border-l-0"
                >
                  {tick}
                </span>
              ))}
            </div>
            <div className="relative h-[22px] border-b border-border">
              <span className="absolute inset-y-[3px] left-0 right-[1%] rounded-[3px] border border-info/50 bg-info/20" />
            </div>
            <div className="relative h-[22px]">
              {timelineBlocks.map((block, i) => (
                <span
                  key={i}
                  className={`absolute inset-y-[3px] rounded-[2.5px] border ${
                    block.active
                      ? 'border-primary bg-primary/50'
                      : 'border-primary/50 bg-primary/20'
                  }`}
                  style={{ left: `${block.left}%`, width: `${block.width}%` }}
                />
              ))}
            </div>
            {/* 播放头 */}
            <span
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary"
              style={{ left: `${(currentTime / duration) * 100}%` }}
            >
              <span className="absolute -left-[3.5px] top-0 border-[4px] border-transparent border-t-primary" />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

import React, { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import ReactPlayer from 'react-player';
import {
  UploadCloud,
  Film,
  Play,
  Pause,
  RotateCcw,
  Scissors,
  CheckCircle2,
  FolderOpen,
  Captions,
  Loader2,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from 'sonner';
import TimelineTrimmerBar from './TimelineTrimmerBar';
import type { VideoTrimResult } from '../../../../types/toolbox';

function formatSeconds(sec: number): string {
  const safe = Math.max(0, sec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 10);

  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  if (h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}.${ms}`;
  }
  return `${pad(m)}:${pad(s)}.${ms}`;
}

function parseTimeString(val: string): number | null {
  const trimmed = val.trim();
  if (!trimmed) return null;

  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    if (parts.length === 2) {
      const min = parseFloat(parts[0]);
      const sec = parseFloat(parts[1]);
      if (!isNaN(min) && !isNaN(sec)) {
        return min * 60 + sec;
      }
    } else if (parts.length === 3) {
      const hr = parseFloat(parts[0]);
      const min = parseFloat(parts[1]);
      const sec = parseFloat(parts[2]);
      if (!isNaN(hr) && !isNaN(min) && !isNaN(sec)) {
        return hr * 3600 + min * 60 + sec;
      }
    }
  }

  const num = parseFloat(trimmed);
  if (!isNaN(num)) {
    return num;
  }
  return null;
}

export default function VideoTrimmerPanel() {
  const { t } = useTranslation('toolbox');
  const router = useRouter();
  const { locale } = router.query;

  const playerRef = useRef<ReactPlayer>(null);

  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<{
    duration: number;
    width: number;
    height: number;
    size: number;
  } | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayingClip, setIsPlayingClip] = useState(false);

  const [inPoint, setInPoint] = useState(0);
  const [outPoint, setOutPoint] = useState(0);

  // 输入框文字编辑状态
  const [inInputText, setInInputText] = useState('00:00.0');
  const [outInputText, setOutInputText] = useState('00:00.0');
  const [isEditingIn, setIsEditingIn] = useState(false);
  const [isEditingOut, setIsEditingOut] = useState(false);

  const [trimMode, setTrimMode] = useState<'lossless' | 'accurate'>('lossless');
  const [outputDir, setOutputDir] = useState<string>('');

  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportResult, setExportResult] = useState<VideoTrimResult | null>(null);
  const currentJobIdRef = useRef<string>('');
  const isCancelledRef = useRef<boolean>(false);

  const totalDuration = videoInfo?.duration || 1;
  const clipDuration = Math.max(0, outPoint - inPoint);

  // 同步外部变化到输入框（仅非编辑中时）
  useEffect(() => {
    if (!isEditingIn) {
      setInInputText(formatSeconds(inPoint));
    }
  }, [inPoint, isEditingIn]);

  useEffect(() => {
    if (!isEditingOut) {
      setOutInputText(formatSeconds(outPoint));
    }
  }, [outPoint, isEditingOut]);

  // 微调入点与出点
  const stepInPoint = (delta: number) => {
    const safe = Math.max(0, Math.min(outPoint - 0.1, Number((inPoint + delta).toFixed(2))));
    setInPoint(safe);
    playerRef.current?.seekTo(safe, 'seconds');
    setCurrentTime(safe);
  };

  const stepOutPoint = (delta: number) => {
    const safe = Math.max(inPoint + 0.1, Math.min(totalDuration, Number((outPoint + delta).toFixed(2))));
    setOutPoint(safe);
    playerRef.current?.seekTo(safe, 'seconds');
    setCurrentTime(safe);
  };

  // 设定当前播放时刻为入点/出点
  const setCurrentAsIn = () => {
    const safe = Math.max(0, Math.min(outPoint - 0.1, Number(currentTime.toFixed(2))));
    setInPoint(safe);
    toast.info(`入点已设定为 ${formatSeconds(safe)}`);
  };

  const setCurrentAsOut = () => {
    const safe = Math.max(inPoint + 0.1, Math.min(totalDuration, Number(currentTime.toFixed(2))));
    setOutPoint(safe);
    toast.info(`出点已设定为 ${formatSeconds(safe)}`);
  };

  // 提交输入框内容
  const commitInInput = () => {
    setIsEditingIn(false);
    const parsed = parseTimeString(inInputText);
    if (parsed !== null) {
      const safe = Math.max(0, Math.min(outPoint - 0.1, Number(parsed.toFixed(2))));
      setInPoint(safe);
      setInInputText(formatSeconds(safe));
      playerRef.current?.seekTo(safe, 'seconds');
      setCurrentTime(safe);
    } else {
      setInInputText(formatSeconds(inPoint));
    }
  };

  const commitOutInput = () => {
    setIsEditingOut(false);
    const parsed = parseTimeString(outInputText);
    if (parsed !== null) {
      const safe = Math.max(inPoint + 0.1, Math.min(totalDuration, Number(parsed.toFixed(2))));
      setOutPoint(safe);
      setOutInputText(formatSeconds(safe));
      playerRef.current?.seekTo(safe, 'seconds');
      setCurrentTime(safe);
    } else {
      setOutInputText(formatSeconds(outPoint));
    }
  };

  // 播放/暂停片段预览
  const handleTogglePlayClip = () => {
    if (isPlayingClip && isPlaying) {
      setIsPlaying(false);
      setIsPlayingClip(false);
    } else {
      playerRef.current?.seekTo(inPoint, 'seconds');
      setCurrentTime(inPoint);
      setIsPlaying(true);
      setIsPlayingClip(true);
    }
  };

  // 监听进度回调
  useEffect(() => {
    const cleanup = window.ipc?.on(
      'toolbox:trimProgress',
      (data: { jobId: string; percent: number }) => {
        if (data.jobId === currentJobIdRef.current) {
          setExportProgress(data.percent);
        }
      },
    );
    return () => {
      cleanup?.();
    };
  }, []);

  // 键盘快捷键 [ 和 ] 设入出点，空格播放暂停，箭头单帧微调
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 避免在 input 输入时触发
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((prev) => !prev);
        setIsPlayingClip(false);
      } else if (e.key === '[') {
        e.preventDefault();
        setCurrentAsIn();
      } else if (e.key === ']') {
        e.preventDefault();
        setCurrentAsOut();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const step = e.shiftKey ? 1.0 : 0.1;
        const next = Math.max(0, currentTime - step);
        playerRef.current?.seekTo(next, 'seconds');
        setCurrentTime(next);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1.0 : 0.1;
        const max = videoInfo?.duration || 1000;
        const next = Math.min(max, currentTime + step);
        playerRef.current?.seekTo(next, 'seconds');
        setCurrentTime(next);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentTime, videoInfo, inPoint, outPoint]);

  // 选择视频文件
  const handleSelectVideo = async () => {
    try {
      const files = await window.ipc.invoke('toolbox:selectFile', {
        type: 'video',
        multiSelections: false,
      });
      if (Array.isArray(files) && files.length > 0) {
        await loadVideo(files[0]);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const loadVideo = async (filePath: string) => {
    setVideoPath(filePath);
    setExportResult(null);
    try {
      const info = await window.ipc.invoke('toolbox:getVideoInfo', filePath);
      if (!info || !info.duration || info.duration <= 0) {
        throw new Error('无法读取该视频的时长，文件可能损坏或格式不受支持');
      }
      setVideoInfo(info);
      setInPoint(0);
      setOutPoint(info.duration);
    } catch (err: any) {
      console.error('Probe video error:', err);
      toast.error(`视频探测失败: ${err.message || err}`);
      setVideoPath(null);
      setVideoInfo(null);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      const p = window.ipc?.getPathForFile
        ? window.ipc.getPathForFile(droppedFiles[0])
        : (droppedFiles[0] as any).path;
      if (p) await loadVideo(p);
    }
  };

  // 播放进度回调
  const handlePlayerProgress = (state: { playedSeconds: number }) => {
    setCurrentTime(state.playedSeconds);
    // 预览片段达到出点时自动暂停
    if (isPlayingClip && state.playedSeconds >= outPoint) {
      setIsPlaying(false);
      setIsPlayingClip(false);
      playerRef.current?.seekTo(outPoint, 'seconds');
      setCurrentTime(outPoint);
    }
  };

  // 选择输出目录
  const handleSelectOutputDir = async () => {
    const picked = await window.ipc.invoke('toolbox:selectFolder');
    if (picked) setOutputDir(picked);
  };

  // 导出裁剪片段
  const handleStartTrim = async () => {
    if (!videoPath || isExporting) return;
    if (outPoint <= inPoint) {
      toast.error('出点必须大于入点');
      return;
    }

    const jobId = `trim_${Date.now()}`;
    currentJobIdRef.current = jobId;
    isCancelledRef.current = false;
    setIsExporting(true);
    setExportProgress(0);
    setExportResult(null);

    try {
      const result: VideoTrimResult = await window.ipc.invoke(
        'toolbox:trimVideo',
        {
          jobId,
          config: {
            videoPath,
            startSec: inPoint,
            endSec: outPoint,
            mode: trimMode,
            outputDir: outputDir || undefined,
          },
        },
      );

      if (isCancelledRef.current) return;

      setExportResult(result);
      if (result.success) {
        toast.success('视频裁剪完成！');
      } else {
        toast.error(`裁剪失败: ${result.error}`);
      }
    } catch (err: any) {
      if (!isCancelledRef.current) {
        toast.error(`裁剪异常: ${err.message || err}`);
      }
    } finally {
      setIsExporting(false);
    }
  };

  const handleCancelTrim = async () => {
    if (currentJobIdRef.current) {
      isCancelledRef.current = true;
      await window.ipc.invoke(
        'toolbox:cancelTrimVideo',
        currentJobIdRef.current,
      );
      setIsExporting(false);
      toast.info('已取消视频裁剪');
    }
  };

  // 跳转新建任务
  const handleSendToTask = () => {
    if (exportResult?.outputPath) {
      router.push(
        `/${locale}/tasks/new?video=${encodeURIComponent(exportResult.outputPath)}`,
      );
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-1 overflow-hidden p-6 gap-6">
        {/* 左侧：播放器与时间轴修剪区 */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
          {!videoPath ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={handleSelectVideo}
              className="flex flex-1 flex-col items-center justify-center border-dashed p-8 text-center transition-colors hover:bg-muted/30 cursor-pointer"
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Film className="h-7 w-7" />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-foreground">
                点击或拖拽视频文件到此处
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                支持 MP4, MKV, MOV, WebM, AVI, TS 等常见视频格式
              </p>
            </div>
          ) : (
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* 播放器区域 */}
              <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
                <ReactPlayer
                  ref={playerRef}
                  url={`media://${encodeURIComponent(videoPath)}`}
                  width="100%"
                  height="100%"
                  playing={isPlaying}
                  controls={false}
                  onProgress={handlePlayerProgress}
                  onEnded={() => setIsPlaying(false)}
                />

                {/* 悬浮控制微条 */}
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full bg-background/80 px-3 py-1.5 shadow-lg backdrop-blur">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 rounded-full"
                    onClick={() => setIsPlaying(!isPlaying)}
                  >
                    {isPlaying ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <span className="font-mono text-xs text-foreground">
                    {formatSeconds(currentTime)} / {formatSeconds(totalDuration)}
                  </span>
                </div>
              </div>

              {/* 底部时间轴与数据精确微调控制区 */}
              <div className="border-t border-border bg-muted/20 p-4 space-y-3">
                {/* 双端拖动手柄时间轴 */}
                <TimelineTrimmerBar
                  duration={totalDuration}
                  currentTime={currentTime}
                  inPoint={inPoint}
                  outPoint={outPoint}
                  onSeek={(target) => {
                    playerRef.current?.seekTo(target, 'seconds');
                    setCurrentTime(target);
                  }}
                  onChangeRange={(newIn, newOut) => {
                    setInPoint(newIn);
                    setOutPoint(newOut);
                  }}
                  disabled={isExporting}
                />

                {/* 选区概览与预览控制栏 */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-card/60 border border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Button
                      variant={isPlayingClip ? 'default' : 'secondary'}
                      size="sm"
                      onClick={handleTogglePlayClip}
                      className="h-7 text-xs px-2.5 gap-1.5"
                    >
                      {isPlayingClip ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      <span>{isPlayingClip ? t('videoTrimmer.pausePreview') : t('videoTrimmer.previewClip')}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setInPoint(0);
                        setOutPoint(totalDuration);
                        playerRef.current?.seekTo(0, 'seconds');
                        setCurrentTime(0);
                      }}
                      className="h-7 text-xs px-2 text-muted-foreground hover:text-foreground"
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      {t('videoTrimmer.resetRange')}
                    </Button>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <span className="text-xs text-muted-foreground">{t('videoTrimmer.duration')}:</span>
                    <Badge variant="secondary" className="font-mono text-xs px-2 py-0.5 font-semibold text-primary">
                      {formatSeconds(clipDuration)}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground/80 font-mono">
                      / {t('videoTrimmer.totalDuration')} {formatSeconds(totalDuration)}
                    </span>
                  </div>
                </div>

                {/* 入点与出点的数据精确微调卡片 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  {/* 入点微调 */}
                  <div className="rounded-lg border border-border bg-card/60 p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        {t('videoTrimmer.inPoint')}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={setCurrentAsIn}
                        className="h-6 text-[11px] px-2 font-mono gap-1"
                        title="将当前播放位置设为入点 (快捷键 [ )"
                      >
                        <span>[ {t('videoTrimmer.setAsIn')}</span>
                        <kbd className="rounded bg-muted px-1 text-[9px] text-muted-foreground border border-border/50">[</kbd>
                      </Button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Input
                        type="text"
                        value={isEditingIn ? inInputText : formatSeconds(inPoint)}
                        onFocus={() => {
                          setIsEditingIn(true);
                          setInInputText(formatSeconds(inPoint));
                        }}
                        onChange={(e) => setInInputText(e.target.value)}
                        onBlur={commitInInput}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitInInput();
                        }}
                        className="h-7 text-xs font-mono w-24 text-center px-1"
                        title="可直接输入秒数或分秒格式 (如 12.5 或 01:23.4)"
                      />
                      <div className="flex items-center gap-1 flex-1 justify-end">
                        <Button variant="outline" size="sm" onClick={() => stepInPoint(-1)} className="h-7 px-1.5 text-[11px] font-mono" title="后退 1 秒">-1s</Button>
                        <Button variant="outline" size="sm" onClick={() => stepInPoint(-0.1)} className="h-7 px-1.5 text-[11px] font-mono" title="后退 0.1 秒">-0.1s</Button>
                        <Button variant="outline" size="sm" onClick={() => stepInPoint(0.1)} className="h-7 px-1.5 text-[11px] font-mono" title="前进 0.1 秒">+0.1s</Button>
                        <Button variant="outline" size="sm" onClick={() => stepInPoint(1)} className="h-7 px-1.5 text-[11px] font-mono" title="前进 1 秒">+1s</Button>
                      </div>
                    </div>
                  </div>

                  {/* 出点微调 */}
                  <div className="rounded-lg border border-border bg-card/60 p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-amber-500" />
                        {t('videoTrimmer.outPoint')}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={setCurrentAsOut}
                        className="h-6 text-[11px] px-2 font-mono gap-1"
                        title="将当前播放位置设为出点 (快捷键 ] )"
                      >
                        <span>] {t('videoTrimmer.setAsOut')}</span>
                        <kbd className="rounded bg-muted px-1 text-[9px] text-muted-foreground border border-border/50">]</kbd>
                      </Button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Input
                        type="text"
                        value={isEditingOut ? outInputText : formatSeconds(outPoint)}
                        onFocus={() => {
                          setIsEditingOut(true);
                          setOutInputText(formatSeconds(outPoint));
                        }}
                        onChange={(e) => setOutInputText(e.target.value)}
                        onBlur={commitOutInput}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitOutInput();
                        }}
                        className="h-7 text-xs font-mono w-24 text-center px-1"
                        title="可直接输入秒数或分秒格式 (如 35.8 或 01:45.0)"
                      />
                      <div className="flex items-center gap-1 flex-1 justify-end">
                        <Button variant="outline" size="sm" onClick={() => stepOutPoint(-1)} className="h-7 px-1.5 text-[11px] font-mono" title="后退 1 秒">-1s</Button>
                        <Button variant="outline" size="sm" onClick={() => stepOutPoint(-0.1)} className="h-7 px-1.5 text-[11px] font-mono" title="后退 0.1 秒">-0.1s</Button>
                        <Button variant="outline" size="sm" onClick={() => stepOutPoint(0.1)} className="h-7 px-1.5 text-[11px] font-mono" title="前进 0.1 秒">+0.1s</Button>
                        <Button variant="outline" size="sm" onClick={() => stepOutPoint(1)} className="h-7 px-1.5 text-[11px] font-mono" title="前进 1 秒">+1s</Button>
                      </div>
                    </div>
                  </div>
                </div>

                <p className="text-[11px] text-muted-foreground text-center">
                  {t('videoTrimmer.shortcutTip')}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 右侧：裁剪选项与导出控制 */}
        <div className="flex w-80 shrink-0 flex-col justify-between rounded-xl border border-border bg-card p-5">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Scissors className="h-4 w-4 text-primary" />
              裁剪设置
            </h3>

            {/* 模式选择 */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                {t('videoTrimmer.mode')}
              </Label>
              <RadioGroup
                value={trimMode}
                onValueChange={(v: any) => setTrimMode(v)}
                className="space-y-2"
                disabled={isExporting}
              >
                <div className="flex items-start space-x-2 rounded-lg border border-border p-2.5 transition-colors hover:bg-muted/30">
                  <RadioGroupItem value="lossless" id="mode-lossless" className="mt-0.5" />
                  <div className="space-y-0.5">
                    <Label htmlFor="mode-lossless" className="text-xs font-medium cursor-pointer">
                      {t('videoTrimmer.modeLossless')}
                    </Label>
                    <p className="text-[11px] text-muted-foreground leading-normal">
                      {t('videoTrimmer.modeLosslessDesc')}
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-2 rounded-lg border border-border p-2.5 transition-colors hover:bg-muted/30">
                  <RadioGroupItem value="accurate" id="mode-accurate" className="mt-0.5" />
                  <div className="space-y-0.5">
                    <Label htmlFor="mode-accurate" className="text-xs font-medium cursor-pointer">
                      {t('videoTrimmer.modeAccurate')}
                    </Label>
                    <p className="text-[11px] text-muted-foreground leading-normal">
                      {t('videoTrimmer.modeAccurateDesc')}
                    </p>
                  </div>
                </div>
              </RadioGroup>
            </div>

            {/* 自定义精确时间调整 */}
            <div className="space-y-2 pt-2 border-t border-border">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">起止秒数 (精准秒数)</Label>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {formatSeconds(clipDuration)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <span className="text-[10px] text-muted-foreground">起始秒</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max={Math.max(0, outPoint - 0.1)}
                    value={Number(inPoint.toFixed(2))}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value) || 0;
                      const safe = Math.max(0, Math.min(outPoint - 0.1, Number(val.toFixed(2))));
                      setInPoint(safe);
                      playerRef.current?.seekTo(safe, 'seconds');
                      setCurrentTime(safe);
                    }}
                    disabled={isExporting || !videoPath}
                    className="h-8 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] text-muted-foreground">结束秒</span>
                  <Input
                    type="number"
                    step="0.01"
                    min={inPoint + 0.1}
                    max={totalDuration}
                    value={Number(outPoint.toFixed(2))}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value) || 0;
                      const safe = Math.max(inPoint + 0.1, Math.min(totalDuration, Number(val.toFixed(2))));
                      setOutPoint(safe);
                      playerRef.current?.seekTo(safe, 'seconds');
                      setCurrentTime(safe);
                    }}
                    disabled={isExporting || !videoPath}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>
            </div>

            {/* 输出目录 */}
            <div className="space-y-1.5 pt-2 border-t border-border">
              <Label className="text-xs text-muted-foreground">
                {t('outputFolder')}
              </Label>
              <div className="flex items-center gap-2">
                <div
                  className="flex-1 truncate rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground"
                  title={outputDir || t('defaultOutputFolder')}
                >
                  {outputDir || t('defaultOutputFolder')}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSelectOutputDir}
                  disabled={isExporting}
                  className="h-8 shrink-0 text-xs px-2.5"
                >
                  {t('changeFolder')}
                </Button>
              </div>
            </div>

            {/* 导出完成与直达任务卡片 */}
            {exportResult?.success && (
              <div className="space-y-2 rounded-lg bg-green-500/10 border border-green-500/20 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" />
                  导出成功！
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {exportResult.outputPath}
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.ipc.invoke('toolbox:openFolder', exportResult.outputPath)}
                    className="h-7 text-xs flex-1 gap-1"
                  >
                    <FolderOpen className="h-3 w-3" />
                    打开文件
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleSendToTask}
                    className="h-7 text-xs flex-1 gap-1 bg-green-600 hover:bg-green-700 text-white"
                  >
                    <Captions className="h-3 w-3" />
                    新建任务
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* 底部操作区 */}
          <div className="pt-4 border-t border-border space-y-2">
            {isExporting ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t('videoTrimmer.exporting')}</span>
                  <span className="font-mono font-medium">{exportProgress}%</span>
                </div>
                <Progress value={exportProgress} className="h-1.5" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancelTrim}
                  className="w-full h-8 text-xs text-destructive hover:text-destructive"
                >
                  {t('cancel')}
                </Button>
              </div>
            ) : (
              <Button
                className="w-full text-xs font-medium h-9"
                onClick={handleStartTrim}
                disabled={!videoPath || clipDuration <= 0}
              >
                <Scissors className="mr-1.5 h-3.5 w-3.5" />
                {t('videoTrimmer.exportButton')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'next-i18next';
import ReactPlayer from 'react-player';
import {
  UploadCloud,
  Film,
  CheckCircle2,
  FolderOpen,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import type { VideoToGifResult } from '../../../../types/toolbox';

export default function VideoToGifPanel() {
  const { t } = useTranslation('toolbox');

  const playerRef = useRef<ReactPlayer>(null);

  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);

  const [startSec, setStartSec] = useState<number>(0);
  const [endSec, setEndSec] = useState<number>(5);
  const [fps, setFps] = useState<number>(12);
  const [width, setWidth] = useState<number>(480);
  const [outputDir, setOutputDir] = useState<string>('');

  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [result, setResult] = useState<VideoToGifResult | null>(null);

  const currentJobIdRef = useRef<string>('');

  useEffect(() => {
    const cleanup = window.ipc?.on(
      'toolbox:gifProgress',
      (data: { jobId: string; percent: number }) => {
        if (data.jobId === currentJobIdRef.current) {
          setProgress(data.percent);
        }
      },
    );
    return () => cleanup?.();
  }, []);

  const handleSelectVideo = async () => {
    const files = await window.ipc.invoke('toolbox:selectFile', {
      type: 'video',
      multiSelections: false,
    });
    if (Array.isArray(files) && files.length > 0) {
      await loadVideo(files[0]);
    }
  };

  const loadVideo = async (filePath: string) => {
    setVideoPath(filePath);
    setResult(null);
    try {
      const info = await window.ipc.invoke('toolbox:getVideoInfo', filePath);
      setVideoDuration(info.duration || 10);
      setStartSec(0);
      setEndSec(Math.min(5, info.duration || 5));
    } catch (err) {
      console.error(err);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const p = window.ipc?.getPathForFile
        ? window.ipc.getPathForFile(files[0])
        : (files[0] as any).path;
      if (p) loadVideo(p);
    }
  };

  const handleStartGif = async () => {
    if (!videoPath || isExporting) return;
    if (endSec <= startSec) {
      toast.error('结束时间必须大于起始时间');
      return;
    }
    if (endSec - startSec > 30) {
      toast.warning('动图片段建议在 10 秒以内，超长片段生成较慢且文件体积巨大');
    }

    const jobId = `gif_${Date.now()}`;
    currentJobIdRef.current = jobId;

    setIsExporting(true);
    setProgress(0);
    setResult(null);

    try {
      const res: VideoToGifResult = await window.ipc.invoke('toolbox:videoToGif', {
        jobId,
        config: {
          videoPath,
          startSec,
          endSec,
          fps,
          width,
          outputPath: outputDir
            ? `${outputDir}/${videoPath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '')}_anim.gif`
            : undefined,
        },
      });
      setResult(res);
      if (res.success) {
        toast.success('高清 GIF 动图生成成功！');
      } else {
        toast.error(`生成失败: ${res.error}`);
      }
    } catch (err: any) {
      toast.error(`生成异常: ${err.message || err}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-1 overflow-hidden p-6 gap-6">
        {/* 左侧：播放器与时间区间 */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
          {!videoPath ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={handleSelectVideo}
              className="flex flex-1 flex-col items-center justify-center p-8 text-center transition-colors hover:bg-muted/30 cursor-pointer"
            >
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Film className="h-7 w-7" />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-foreground">
                点击或拖拽视频到此处截取动图
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                截取精彩片段，生成无噪点的高清 GIF 表情包
              </p>
            </div>
          ) : (
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
                <ReactPlayer
                  ref={playerRef}
                  url={`media://${encodeURIComponent(videoPath)}`}
                  width="100%"
                  height="100%"
                  controls={true}
                  onProgress={(s) => setCurrentTime(s.playedSeconds)}
                />
              </div>

              {/* 时间控制 */}
              <div className="border-t border-border bg-muted/20 p-4 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setStartSec(currentTime)}
                      className="h-7 text-xs px-2"
                    >
                      设当前为起点
                    </Button>
                    <span className="font-mono text-muted-foreground">
                      {startSec.toFixed(2)}s
                    </span>
                  </div>

                  <span className="font-mono text-xs font-semibold text-primary">
                    动图时长: {(endSec - startSec).toFixed(2)} 秒
                  </span>

                  <div className="flex items-center gap-2">
                    <span className="font-mono text-muted-foreground">
                      {endSec.toFixed(2)}s
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEndSec(currentTime)}
                      className="h-7 text-xs px-2"
                    >
                      设当前为终点
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 右侧：GIF 参数 */}
        <div className="flex w-80 shrink-0 flex-col justify-between rounded-xl border border-border bg-card p-5">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              动图参数
            </h3>

            {/* 帧率 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">动图帧率 (FPS)</Label>
              <Select
                value={String(fps)}
                onValueChange={(v) => setFps(parseInt(v, 10))}
                disabled={isExporting}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 fps (体积小)</SelectItem>
                  <SelectItem value="12">12 fps (经典流畅)</SelectItem>
                  <SelectItem value="15">15 fps (高帧率逼真)</SelectItem>
                  <SelectItem value="20">20 fps (极度丝滑)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 宽度 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">动图宽度 (等比缩放)</Label>
              <Select
                value={String(width)}
                onValueChange={(v) => setWidth(parseInt(v, 10))}
                disabled={isExporting}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="320">320 px (表情包尺寸)</SelectItem>
                  <SelectItem value="480">480 px (标准中图)</SelectItem>
                  <SelectItem value="640">640 px (高清大图)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-lg bg-muted/40 p-3 text-[11px] text-muted-foreground leading-relaxed">
              💡 采用双通道 PaletteGen 调色板渲染算法，避免传统 GIF 出现的彩点噪点和严重色斑。
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
                  onClick={async () => {
                    const picked = await window.ipc.invoke('toolbox:selectFolder');
                    if (picked) setOutputDir(picked);
                  }}
                  disabled={isExporting}
                  className="h-8 shrink-0 text-xs px-2.5"
                >
                  {t('changeFolder')}
                </Button>
              </div>
            </div>

            {result?.success && (
              <div className="space-y-2 rounded-lg bg-green-500/10 border border-green-500/20 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" />
                  生成完成！
                </div>
                <p className="truncate text-[11px] text-muted-foreground">
                  {result.outputPath}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.ipc.invoke('toolbox:openFolder', result.outputPath)}
                  className="w-full h-7 text-xs gap-1 mt-1"
                >
                  <FolderOpen className="h-3 w-3" />
                  打开所在目录
                </Button>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-border space-y-2">
            {isExporting ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">正在渲染动图...</span>
                  <span className="font-mono font-medium">{progress}%</span>
                </div>
                <Progress value={progress} className="h-1.5" />
              </div>
            ) : (
              <Button
                className="w-full text-xs font-medium h-9"
                onClick={handleStartGif}
                disabled={!videoPath || endSec <= startSec}
              >
                <Film className="mr-1.5 h-3.5 w-3.5" />
                生成高清 GIF
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

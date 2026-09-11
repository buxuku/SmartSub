import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'next-i18next';
import {
  UploadCloud,
  Minimize2,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { toast } from 'sonner';
import type {
  VideoCompressPreset,
  VideoCompressResult,
} from '../../../../types/toolbox';

function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export default function VideoCompressorPanel() {
  const { t } = useTranslation('toolbox');

  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [preset, setPreset] = useState<VideoCompressPreset>('wechat_25mb');
  const [targetSizeMb, setTargetSizeMb] = useState<number>(24);
  const [outputDir, setOutputDir] = useState<string>('');

  const [isCompressing, setIsCompressing] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [result, setResult] = useState<VideoCompressResult | null>(null);

  const currentJobIdRef = useRef<string>('');

  useEffect(() => {
    const cleanup = window.ipc?.on(
      'toolbox:compressProgress',
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
      setVideoPath(files[0]);
      setFileName(files[0].split(/[/\\]/).pop() || '');
      setResult(null);
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
      if (p) {
        setVideoPath(p);
        setFileName(p.split(/[/\\]/).pop() || '');
        setResult(null);
      }
    }
  };

  const handleStartCompress = async () => {
    if (!videoPath || isCompressing) return;

    const jobId = `compress_${Date.now()}`;
    currentJobIdRef.current = jobId;

    setIsCompressing(true);
    setProgress(0);
    setResult(null);

    try {
      const res: VideoCompressResult = await window.ipc.invoke(
        'toolbox:compressVideo',
        {
          jobId,
          config: {
            videoPath,
            preset,
            targetSizeMb,
            outputPath: outputDir
              ? `${outputDir}/${fileName.replace(/\.[^.]+$/, '')}_compressed.mp4`
              : undefined,
          },
        },
      );
      setResult(res);
      if (res.success) {
        toast.success('视频压缩完成！');
      } else {
        toast.error(`压缩失败: ${res.error}`);
      }
    } catch (err: any) {
      toast.error(`压缩异常: ${err.message || err}`);
    } finally {
      setIsCompressing(false);
    }
  };

  const handleCancel = async () => {
    if (currentJobIdRef.current) {
      await window.ipc.invoke('toolbox:cancelCompressVideo', currentJobIdRef.current);
      setIsCompressing(false);
      toast.info('已取消视频压缩');
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-1 overflow-hidden p-6 gap-6">
        {/* 左侧：文件与档位 */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card p-6 gap-6">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={handleSelectVideo}
            className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 transition-colors hover:bg-muted/40 cursor-pointer"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UploadCloud className="h-6 w-6" />
            </div>
            <p className="mt-2 text-xs font-medium text-foreground">
              {fileName || '点击或拖拽需要压缩的视频文件到此处'}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              基于 H.264 与智能码率自适应，快速减少体积便于社交平台分享
            </p>
          </div>

          <div className="space-y-3">
            <Label className="text-xs font-semibold text-foreground">
              压缩预设档位
            </Label>
            <RadioGroup
              value={preset}
              onValueChange={(v: any) => setPreset(v)}
              className="space-y-2.5"
              disabled={isCompressing}
            >
              <div className="flex items-start space-x-2 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30">
                <RadioGroupItem value="wechat_25mb" id="p-wechat" className="mt-0.5" />
                <div className="space-y-0.5">
                  <Label htmlFor="p-wechat" className="text-xs font-medium cursor-pointer">
                    微信分享预设 (限制 25MB 以内)
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    根据视频时长自动反算目标码率并降至 720p，适配微信直接发送限制
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-2 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30">
                <RadioGroupItem value="balanced_1080p" id="p-balanced" className="mt-0.5" />
                <div className="space-y-0.5">
                  <Label htmlFor="p-balanced" className="text-xs font-medium cursor-pointer">
                    1080p 社交均衡压缩
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    保持 1080p 分辨率，采用 CRF 24 优化码率，兼顾清晰度与传输速度
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-2 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30">
                <RadioGroupItem value="fast_720p" id="p-fast" className="mt-0.5" />
                <div className="space-y-0.5">
                  <Label htmlFor="p-fast" className="text-xs font-medium cursor-pointer">
                    720p 快速省流压缩
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    快速压制为 720p 较小体积，编码更快
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-2 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30">
                <RadioGroupItem value="target_size" id="p-target" className="mt-0.5" />
                <div className="space-y-1.5 flex-1">
                  <Label htmlFor="p-target" className="text-xs font-medium cursor-pointer">
                    指定目标文件体积
                  </Label>
                  {preset === 'target_size' && (
                    <div className="flex items-center gap-2 pt-1">
                      <Input
                        type="number"
                        min="1"
                        max="1000"
                        value={targetSizeMb}
                        onChange={(e) => setTargetSizeMb(parseInt(e.target.value, 10) || 10)}
                        className="h-7 w-24 text-xs font-mono"
                      />
                      <span className="text-xs text-muted-foreground">MB</span>
                    </div>
                  )}
                </div>
              </div>
            </RadioGroup>
          </div>
        </div>

        {/* 右侧：保存控制与执行 */}
        <div className="flex w-80 shrink-0 flex-col justify-between rounded-xl border border-border bg-card p-5">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              导出设置
            </h3>

            <div className="space-y-1.5">
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
                  disabled={isCompressing}
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
                  压缩完成！
                </div>
                <div className="text-[11px] text-muted-foreground space-y-0.5 font-mono">
                  <div>原大小: {formatFileSize(result.originalSize)}</div>
                  <div className="text-foreground font-semibold">
                    压缩后: {formatFileSize(result.compressedSize)} (节省{' '}
                    {(
                      ((result.originalSize - result.compressedSize) /
                        result.originalSize) *
                      100
                    ).toFixed(1)}
                    %)
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.ipc.invoke('toolbox:openFolder', result.outputPath)}
                  className="w-full h-7 text-xs gap-1 mt-1"
                >
                  <FolderOpen className="h-3 w-3" />
                  打开文件所在目录
                </Button>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-border space-y-2">
            {isCompressing ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">正在压缩视频...</span>
                  <span className="font-mono font-medium">{progress}%</span>
                </div>
                <Progress value={progress} className="h-1.5" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  className="w-full h-8 text-xs text-destructive hover:text-destructive"
                >
                  取消
                </Button>
              </div>
            ) : (
              <Button
                className="w-full text-xs font-medium h-9"
                onClick={handleStartCompress}
                disabled={!videoPath}
              >
                <Minimize2 className="mr-1.5 h-3.5 w-3.5" />
                开始压缩视频
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

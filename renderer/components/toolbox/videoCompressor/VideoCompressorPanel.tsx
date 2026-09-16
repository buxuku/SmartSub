import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'next-i18next';
import {
  UploadCloud,
  Minimize2,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  Trash2,
  Film,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import ToolboxFinishBar from '../common/ToolboxFinishBar';
import type {
  VideoCompressPreset,
  VideoCompressResult,
} from '../../../../types/toolbox';

export interface CompressQueueItem {
  id: string;
  filePath: string;
  fileName: string;
  status: 'idle' | 'processing' | 'done' | 'error';
  progress: number;
  result?: VideoCompressResult;
  error?: string;
}

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export default function VideoCompressorPanel() {
  const { t } = useTranslation('toolbox');

  const [files, setFiles] = useState<CompressQueueItem[]>([]);
  const [preset, setPreset] = useState<VideoCompressPreset>('wechat_25mb');
  const [targetSizeMb, setTargetSizeMb] = useState<number>(24);
  const [outputDir, setOutputDir] = useState<string>('');

  const [isCompressing, setIsCompressing] = useState<boolean>(false);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [currentProgress, setCurrentProgress] = useState<number>(0);

  const currentJobIdRef = useRef<string>('');
  const cancelledRef = useRef<boolean>(false);

  useEffect(() => {
    const cleanup = window.ipc?.on(
      'toolbox:compressProgress',
      (data: { jobId: string; percent: number }) => {
        if (data.jobId === currentJobIdRef.current) {
          setCurrentProgress(data.percent);
          setFiles((prev) =>
            prev.map((f) =>
              f.status === 'processing' ? { ...f, progress: data.percent } : f,
            ),
          );
        }
      },
    );
    return () => cleanup?.();
  }, []);

  const addFilesToQueue = (filePaths: string[]) => {
    const newItems: CompressQueueItem[] = filePaths.map((p) => ({
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      filePath: p,
      fileName: p.split(/[/\\]/).pop() || '',
      status: 'idle',
      progress: 0,
    }));
    setFiles((prev) => {
      const existingPaths = new Set(prev.map((item) => item.filePath));
      const filtered = newItems.filter(
        (item) => !existingPaths.has(item.filePath),
      );
      return [...prev, ...filtered];
    });
  };

  const handleSelectVideo = async () => {
    const selected = await window.ipc.invoke('toolbox:selectFile', {
      type: 'video',
      multiSelections: true,
    });
    if (Array.isArray(selected) && selected.length > 0) {
      addFilesToQueue(selected);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const dropped = Array.from(e.dataTransfer.files);
    const paths: string[] = [];
    for (const f of dropped) {
      const p = window.ipc?.getPathForFile
        ? window.ipc.getPathForFile(f)
        : (f as any).path;
      if (p) paths.push(p);
    }
    if (paths.length > 0) {
      addFilesToQueue(paths);
    }
  };

  const handleStartCompress = async () => {
    if (files.length === 0 || isCompressing) return;

    setIsCompressing(true);
    cancelledRef.current = false;

    for (let i = 0; i < files.length; i++) {
      if (cancelledRef.current) break;
      const item = files[i];
      if (item.status === 'done') continue;

      setCurrentIndex(i);
      setCurrentProgress(0);
      setFiles((prev) =>
        prev.map((f, idx) =>
          idx === i ? { ...f, status: 'processing', progress: 0 } : f,
        ),
      );

      const jobId = `compress_${Date.now()}_${i}`;
      currentJobIdRef.current = jobId;

      try {
        const outPath = outputDir
          ? `${outputDir}/${item.fileName.replace(/\.[^.]+$/, '')}_compressed.mp4`
          : undefined;

        const res: VideoCompressResult = await window.ipc.invoke(
          'toolbox:compressVideo',
          {
            jobId,
            config: {
              videoPath: item.filePath,
              preset,
              targetSizeMb,
              outputPath: outPath,
            },
          },
        );

        if (res.success) {
          setFiles((prev) =>
            prev.map((f, idx) =>
              idx === i
                ? { ...f, status: 'done', progress: 100, result: res }
                : f,
            ),
          );
        } else {
          setFiles((prev) =>
            prev.map((f, idx) =>
              idx === i
                ? {
                    ...f,
                    status: 'error',
                    error: res.error || 'Compression failed',
                  }
                : f,
            ),
          );
        }
      } catch (err: any) {
        if (!cancelledRef.current) {
          setFiles((prev) =>
            prev.map((f, idx) =>
              idx === i
                ? {
                    ...f,
                    status: 'error',
                    error: err?.message || 'Error occurred',
                  }
                : f,
            ),
          );
        }
      }
    }

    setIsCompressing(false);
  };

  const handleCancel = async () => {
    cancelledRef.current = true;
    if (currentJobIdRef.current) {
      await window.ipc.invoke(
        'toolbox:cancelCompressVideo',
        currentJobIdRef.current,
      );
    }
    setFiles((prev) =>
      prev.map((f) =>
        f.status === 'processing' ? { ...f, status: 'idle', progress: 0 } : f,
      ),
    );
    setIsCompressing(false);
    toast.info('已取消批量视频压缩');
  };

  const handleRemoveItem = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const doneItems = files.filter(
    (f) => f.status === 'done' && f.result?.success,
  );
  const totalOriginal = doneItems.reduce(
    (acc, cur) => acc + (cur.result?.originalSize || 0),
    0,
  );
  const totalCompressed = doneItems.reduce(
    (acc, cur) => acc + (cur.result?.compressedSize || 0),
    0,
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-1 overflow-hidden p-6 gap-6">
        {/* 左侧：文件列表与档位 */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card p-6 gap-5">
          {/* 拖拽上传区 */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={handleSelectVideo}
            className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-6 transition-colors hover:bg-muted/40 cursor-pointer shrink-0"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UploadCloud className="h-5 w-5" />
            </div>
            <p className="mt-2 text-xs font-medium text-foreground">
              点击或拖拽视频文件到此处（支持多选批量压缩）
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              基于 H.264 与智能码率自适应，快速减少体积便于社交平台分享
            </p>
          </div>

          {/* 视频队列列表 */}
          {files.length > 0 && (
            <div className="flex flex-1 flex-col overflow-hidden space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">
                  {t('videoCompressorQueue.queueTitle')} ({files.length})
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleSelectVideo}
                    disabled={isCompressing}
                    className="h-6 text-xs gap-1 px-2 text-muted-foreground hover:text-foreground"
                  >
                    <Plus className="h-3 w-3" />
                    {t('videoCompressorQueue.addFiles')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setFiles([])}
                    disabled={isCompressing}
                    className="h-6 text-xs gap-1 px-2 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('videoCompressorQueue.clearAll')}
                  </Button>
                </div>
              </div>

              <ScrollArea className="flex-1 rounded-lg border border-border bg-muted/20 p-2">
                <div className="space-y-1.5">
                  {files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <Film className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-foreground">
                            {file.fileName}
                          </p>
                          {file.status === 'processing' && (
                            <div className="flex items-center gap-2 pt-1">
                              <Progress
                                value={file.progress}
                                className="h-1 flex-1"
                              />
                              <span className="text-[10px] font-mono text-muted-foreground">
                                {file.progress}%
                              </span>
                            </div>
                          )}
                          {file.status === 'done' && file.result && (
                            <p className="text-[10px] text-muted-foreground">
                              {formatFileSize(file.result.originalSize)} →{' '}
                              <strong className="text-foreground">
                                {formatFileSize(file.result.compressedSize)}
                              </strong>{' '}
                              (省{' '}
                              {(
                                ((file.result.originalSize -
                                  file.result.compressedSize) /
                                  file.result.originalSize) *
                                100
                              ).toFixed(1)}
                              %)
                            </p>
                          )}
                          {file.status === 'error' && (
                            <p className="text-[10px] text-destructive truncate">
                              {file.error}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {file.status === 'done' && (
                          <Badge
                            variant="secondary"
                            className="bg-green-500/10 text-green-600 dark:text-green-400 gap-1 text-[10px] h-5"
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            已完成
                          </Badge>
                        )}
                        {file.status === 'processing' && (
                          <Badge
                            variant="outline"
                            className="gap-1 text-[10px] h-5"
                          >
                            <Loader2 className="h-3 w-3 animate-spin text-primary" />
                            处理中
                          </Badge>
                        )}
                        {file.status === 'error' && (
                          <Badge
                            variant="destructive"
                            className="gap-1 text-[10px] h-5"
                          >
                            <AlertCircle className="h-3 w-3" />
                            失败
                          </Badge>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveItem(file.id)}
                          disabled={isCompressing}
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* 预设档位 */}
          <div className="space-y-2.5 shrink-0 pt-2 border-t border-border">
            <Label className="text-xs font-semibold text-foreground">
              {t('videoCompressor.preset')}
            </Label>
            <RadioGroup
              value={preset}
              onValueChange={(v: any) => setPreset(v)}
              className="space-y-2"
              disabled={isCompressing}
            >
              <div className="flex items-start space-x-2.5">
                <RadioGroupItem
                  value="wechat_25mb"
                  id="p-wechat"
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <Label
                    htmlFor="p-wechat"
                    className="text-xs font-medium cursor-pointer"
                  >
                    微信分享预设 (&lt; 25MB)
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    自动限制视频体积在 25MB 内，并自适应码率，保证微信秒发
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-2.5">
                <RadioGroupItem
                  value="balanced_1080p"
                  id="p-balanced"
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <Label
                    htmlFor="p-balanced"
                    className="text-xs font-medium cursor-pointer"
                  >
                    1080p 社交均衡压缩
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    H.264 CRF 24 编码，适合小红书、抖音、B站等主流高清分享
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-2.5">
                <RadioGroupItem
                  value="fast_720p"
                  id="p-fast"
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <Label
                    htmlFor="p-fast"
                    className="text-xs font-medium cursor-pointer"
                  >
                    720p 快速压缩
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    降分辨率至 720p 并降低码率，体积超小，传输更迅捷
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-2.5">
                <RadioGroupItem
                  value="target_size"
                  id="p-target"
                  className="mt-0.5"
                />
                <div className="space-y-1 flex-1">
                  <Label
                    htmlFor="p-target"
                    className="text-xs font-medium cursor-pointer"
                  >
                    指定目标文件体积
                  </Label>
                  {preset === 'target_size' && (
                    <div className="flex items-center gap-2 pt-1">
                      <Input
                        type="number"
                        min="1"
                        max="1000"
                        value={targetSizeMb}
                        onChange={(e) =>
                          setTargetSizeMb(parseInt(e.target.value, 10) || 10)
                        }
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
                    const picked = await window.ipc.invoke(
                      'toolbox:selectFolder',
                    );
                    if (picked) setOutputDir(picked);
                  }}
                  disabled={isCompressing}
                  className="h-8 shrink-0 text-xs px-2.5"
                >
                  {t('changeFolder')}
                </Button>
              </div>
            </div>

            {/* 完成闭环行动条 */}
            {doneItems.length > 0 && !isCompressing && (
              <ToolboxFinishBar
                outputType="video"
                outputPaths={
                  doneItems
                    .map((d) => d.result?.outputPath)
                    .filter(Boolean) as string[]
                }
                summary={t('videoCompressorQueue.allFinished', {
                  count: doneItems.length,
                })}
                stats={{
                  originalSize: totalOriginal,
                  compressedSize: totalCompressed,
                }}
                onReset={() => setFiles([])}
              />
            )}
          </div>

          <div className="pt-4 border-t border-border space-y-2">
            {isCompressing ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {t('videoCompressorQueue.compressingItem', {
                      current: currentIndex + 1,
                      total: files.length,
                    })}
                  </span>
                  <span className="font-mono font-medium">
                    {currentProgress}%
                  </span>
                </div>
                <Progress value={currentProgress} className="h-1.5" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancel}
                  className="w-full h-8 text-xs text-destructive hover:text-destructive"
                >
                  {t('cancel')}
                </Button>
              </div>
            ) : (
              <Button
                className="w-full text-xs font-medium h-9"
                onClick={handleStartCompress}
                disabled={files.length === 0}
              >
                <Minimize2 className="mr-1.5 h-3.5 w-3.5" />
                {files.length > 1
                  ? t('videoCompressorQueue.compressAll')
                  : t('videoCompressor.startCompress')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

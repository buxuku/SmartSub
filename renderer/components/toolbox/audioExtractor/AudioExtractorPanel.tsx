import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import {
  UploadCloud,
  Music,
  FileAudio,
  Trash2,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import type { AudioExtractFormat, AudioExtractResult } from '../../../../types/toolbox';

interface AudioItem {
  id: string;
  filePath: string;
  fileName: string;
  status: 'ready' | 'extracting' | 'done' | 'error';
  outputPath?: string;
  error?: string;
}

export default function AudioExtractorPanel() {
  const { t } = useTranslation('toolbox');

  const [files, setFiles] = useState<AudioItem[]>([]);
  const [format, setFormat] = useState<AudioExtractFormat>('mp3');
  const [bitrate, setBitrate] = useState<'128k' | '192k' | '256k' | '320k'>('320k');
  const [wavPreset, setWavPreset] = useState<'standard' | 'asr_16k_mono'>('standard');
  const [outputDir, setOutputDir] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  const currentJobIdRef = useRef<string>('');

  useEffect(() => {
    const cleanup = window.ipc?.on(
      'toolbox:audioProgress',
      (data: { jobId: string; percent: number }) => {
        if (data.jobId === currentJobIdRef.current) {
          setProgress(data.percent);
        }
      },
    );
    return () => cleanup?.();
  }, []);

  const addFiles = (paths: string[]) => {
    const existing = new Set(files.map((f) => f.filePath));
    const toAdd = paths.filter((p) => !existing.has(p));
    const newItems: AudioItem[] = toAdd.map((p) => ({
      id: Math.random().toString(36).slice(2),
      filePath: p,
      fileName: p.split(/[/\\]/).pop() || '',
      status: 'ready',
    }));
    setFiles((prev) => [...prev, ...newItems]);
  };

  const handleSelectFiles = async () => {
    const selected = await window.ipc.invoke('toolbox:selectFile', {
      type: 'video',
      multiSelections: true,
    });
    if (Array.isArray(selected) && selected.length > 0) {
      addFiles(selected);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const droppedFiles = Array.from(e.dataTransfer.files);
    const paths = droppedFiles
      .map((f) => (window.ipc?.getPathForFile ? window.ipc.getPathForFile(f) : (f as any).path))
      .filter(Boolean);
    addFiles(paths);
  };

  const handleStartExtract = async () => {
    if (files.length === 0 || isProcessing) return;

    setIsProcessing(true);
    setProgress(0);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setFiles((prev) =>
        prev.map((f) =>
          f.id === file.id ? { ...f, status: 'extracting', error: undefined } : f,
        ),
      );

      const jobId = `audio_${Date.now()}_${i}`;
      currentJobIdRef.current = jobId;

      try {
        const res: AudioExtractResult = await window.ipc.invoke(
          'toolbox:extractAudio',
          {
            jobId,
            config: {
              videoPath: file.filePath,
              format,
              bitrate,
              wavPreset: format === 'wav' ? wavPreset : undefined,
              outputPath: outputDir
                ? `${outputDir}/${file.fileName.replace(/\.[^.]+$/, '')}.${format}`
                : undefined,
            },
          },
        );

        setFiles((prev) =>
          prev.map((f) =>
            f.id === file.id
              ? {
                  ...f,
                  status: res.success ? 'done' : 'error',
                  outputPath: res.outputPath,
                  error: res.error,
                }
              : f,
          ),
        );
      } catch (err: any) {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === file.id ? { ...f, status: 'error', error: err.message || err } : f,
          ),
        );
      }
    }

    setIsProcessing(false);
    toast.success('音频提取处理完毕');
  };

  const handleSelectOutputDir = async () => {
    const picked = await window.ipc.invoke('toolbox:selectFolder');
    if (picked) setOutputDir(picked);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-1 overflow-hidden p-6 gap-6">
        {/* 左侧：文件列表 */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={handleSelectFiles}
            className="flex flex-col items-center justify-center border-b border-dashed border-border p-6 transition-colors hover:bg-muted/50 cursor-pointer"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UploadCloud className="h-6 w-6" />
            </div>
            <p className="mt-2.5 text-xs font-medium text-foreground">
              拖拽视频文件到此处，或点击浏览选择
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              支持批量提取多个视频音轨，秒级抽离音频
            </p>
          </div>

          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5">
            <span className="text-xs font-medium text-foreground">
              待处理视频: {files.length} 个
            </span>
            {files.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFiles([])}
                disabled={isProcessing}
                className="h-7 text-xs text-muted-foreground hover:text-destructive"
              >
                清空列表
              </Button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-border/60">
            {files.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center text-center text-xs text-muted-foreground">
                <Music className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <span>暂无待处理的视频</span>
              </div>
            ) : (
              files.map((file) => (
                <div
                  key={file.id}
                  className="flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <FileAudio className="h-5 w-5 shrink-0 text-primary/80" />
                    <div className="min-w-0">
                      <span className="truncate text-xs font-medium text-foreground block">
                        {file.fileName}
                      </span>
                      {file.outputPath && (
                        <p className="truncate text-[11px] text-muted-foreground mt-0.5">
                          {file.outputPath}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    {file.status === 'extracting' && (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    )}
                    {file.status === 'done' && (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-green-600 dark:text-green-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        完成
                      </span>
                    )}
                    {file.status === 'error' && (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-destructive">
                        <AlertCircle className="h-3.5 w-3.5" />
                        失败
                      </span>
                    )}

                    {file.outputPath && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => window.ipc.invoke('toolbox:openFolder', file.outputPath!)}
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setFiles((prev) => prev.filter((f) => f.id !== file.id))}
                      disabled={isProcessing}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右侧：提取设置 */}
        <div className="flex w-80 shrink-0 flex-col justify-between rounded-xl border border-border bg-card p-5">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              音频选项
            </h3>

            {/* 格式选择 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">目标格式</Label>
              <Select
                value={format}
                onValueChange={(v: any) => setFormat(v)}
                disabled={isProcessing}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mp3">MP3 (通用兼容)</SelectItem>
                  <SelectItem value="wav">WAV (无损 / 语音识别)</SelectItem>
                  <SelectItem value="aac">AAC (高质量流媒体)</SelectItem>
                  <SelectItem value="m4a">M4A (Apple 生态)</SelectItem>
                  <SelectItem value="flac">FLAC (高解析无损)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* MP3/AAC 码率 */}
            {['mp3', 'aac', 'm4a'].includes(format) && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">音频码率</Label>
                <Select
                  value={bitrate}
                  onValueChange={(v: any) => setBitrate(v)}
                  disabled={isProcessing}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="320k">320 kbps (最高品质)</SelectItem>
                    <SelectItem value="256k">256 kbps (高品质)</SelectItem>
                    <SelectItem value="192k">192 kbps (标准音乐)</SelectItem>
                    <SelectItem value="128k">128 kbps (高压缩语音)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* WAV 预设 */}
            {format === 'wav' && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">WAV 音轨规范</Label>
                <Select
                  value={wavPreset}
                  onValueChange={(v: any) => setWavPreset(v)}
                  disabled={isProcessing}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">原音频采样率与声道</SelectItem>
                    <SelectItem value="asr_16k_mono">16kHz 单声道 (ASR 转写标准)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

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
                  disabled={isProcessing}
                  className="h-8 shrink-0 text-xs px-2.5"
                >
                  {t('changeFolder')}
                </Button>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-border">
            <Button
              className="w-full text-xs font-medium h-9"
              onClick={handleStartExtract}
              disabled={files.length === 0 || isProcessing}
            >
              {isProcessing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  提取中...
                </>
              ) : (
                '开始提取音频'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

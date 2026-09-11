import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  UploadCloud,
  FileSearch,
  CheckCircle2,
  FolderOpen,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import type {
  EmbeddedSubtitleStreamInfo,
  ExtractEmbeddedSubtitleResult,
} from '../../../../types/toolbox';

export default function EmbeddedSubtitlePanel() {
  const { t } = useTranslation('toolbox');

  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [streams, setStreams] = useState<EmbeddedSubtitleStreamInfo[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [targetFormat, setTargetFormat] = useState<'srt' | 'ass' | 'vtt'>('srt');
  const [outputDir, setOutputDir] = useState<string>('');

  const [isScanning, setIsScanning] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractedResult, setExtractedResult] = useState<ExtractEmbeddedSubtitleResult | null>(null);

  const scanVideo = async (filePath: string) => {
    setVideoPath(filePath);
    setIsScanning(true);
    setStreams([]);
    setSelectedIndices([]);
    setExtractedResult(null);

    try {
      const detected: EmbeddedSubtitleStreamInfo[] = await window.ipc.invoke(
        'toolbox:scanEmbeddedSubtitles',
        filePath,
      );
      setStreams(detected);
      if (detected.length > 0) {
        // 默认只选中可直接转为文本的字幕轨 (isText: true)
        const textTracks = detected.filter((s) => s.isText).map((s) => s.subIndex);
        setSelectedIndices(textTracks);
      } else {
        toast.info('未在该视频中探测到内封软字幕轨');
      }
    } catch (err: any) {
      toast.error(`扫描失败: ${err.message || err}`);
    } finally {
      setIsScanning(false);
    }
  };

  const handleSelectVideo = async () => {
    const files = await window.ipc.invoke('toolbox:selectFile', {
      type: 'video',
      multiSelections: false,
    });
    if (Array.isArray(files) && files.length > 0) {
      await scanVideo(files[0]);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const p = window.ipc?.getPathForFile
        ? window.ipc.getPathForFile(files[0])
        : (files[0] as any).path;
      if (p) await scanVideo(p);
    }
  };

  const toggleSelectAll = () => {
    const textIndices = streams.filter((s) => s.isText).map((s) => s.subIndex);
    if (textIndices.length === 0) return;
    if (selectedIndices.length >= textIndices.length) {
      setSelectedIndices([]);
    } else {
      setSelectedIndices(textIndices);
    }
  };

  const toggleIndex = (stream: EmbeddedSubtitleStreamInfo) => {
    if (!stream.isText) {
      toast.info(`轨道 #${stream.subIndex + 1} (${stream.codec}) 为位图字幕，不支持提取为纯文本`);
      return;
    }
    const idx = stream.subIndex;
    setSelectedIndices((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx],
    );
  };

  const handleExtract = async () => {
    if (!videoPath || selectedIndices.length === 0 || isExtracting) return;

    setIsExtracting(true);
    try {
      const result: ExtractEmbeddedSubtitleResult = await window.ipc.invoke(
        'toolbox:extractEmbeddedSubtitles',
        {
          videoPath,
          streamIndices: selectedIndices,
          targetFormat,
          outputDir: outputDir || undefined,
        },
      );
      setExtractedResult(result);
      if (result.success) {
        toast.success(`成功提取 ${result.extractedFiles.length} 条字幕轨！`);
      } else {
        toast.error(`提取失败: ${result.error}`);
      }
    } catch (err: any) {
      toast.error(`提取异常: ${err.message || err}`);
    } finally {
      setIsExtracting(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-1 overflow-hidden p-6 gap-6">
        {/* 左侧：视频与字幕轨表格 */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={handleSelectVideo}
            className="flex flex-col items-center justify-center border-b border-dashed border-border p-6 transition-colors hover:bg-muted/50 cursor-pointer"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UploadCloud className="h-6 w-6" />
            </div>
            <p className="mt-2.5 text-xs font-medium text-foreground">
              {videoPath ? videoPath.split(/[/\\]/).pop() : '点击或拖拽 MKV/MP4 视频到此处扫描'}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              快速扫描容器内嵌的 SubRip、ASS、WebVTT、mov_text 软字幕轨
            </p>
          </div>

          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5">
            <span className="text-xs font-medium text-foreground">
              发现字幕轨: {streams.length} 条
            </span>
            {streams.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleSelectAll}
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
              >
                {selectedIndices.length === streams.length ? '取消全选' : '全选'}
              </Button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {isScanning ? (
              <div className="flex h-48 flex-col items-center justify-center text-xs text-muted-foreground gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span>正在扫描内嵌字幕轨...</span>
              </div>
            ) : streams.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center text-center text-xs text-muted-foreground">
                <FileSearch className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <span>{videoPath ? '未发现文本字幕轨' : '请先选择视频文件'}</span>
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {streams.map((stream) => {
                  const isSelectable = stream.isText;
                  const isChecked = selectedIndices.includes(stream.subIndex);

                  return (
                    <div
                      key={stream.subIndex}
                      onClick={() => toggleIndex(stream)}
                      className={cn(
                        'flex items-center justify-between px-4 py-3 transition-colors',
                        isSelectable
                          ? 'hover:bg-muted/30 cursor-pointer'
                          : 'opacity-60 cursor-not-allowed bg-muted/10',
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <Checkbox
                          checked={isChecked}
                          disabled={!isSelectable}
                          onCheckedChange={() => toggleIndex(stream)}
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground">
                              轨道 #{stream.subIndex + 1}
                            </span>
                            <Badge variant="outline" className="text-[10px] font-mono py-0 h-4">
                              {stream.codec.toUpperCase()}
                            </Badge>
                            {stream.language && (
                              <Badge variant="secondary" className="text-[10px] py-0 h-4">
                                {stream.language}
                              </Badge>
                            )}
                            {stream.isDefault && (
                              <Badge className="text-[10px] py-0 h-4 bg-primary/20 text-primary border-transparent">
                                Default
                              </Badge>
                            )}
                            {!isSelectable && (
                              <Badge variant="outline" className="text-[10px] py-0 h-4 border-amber-500/40 text-amber-600 dark:text-amber-400">
                                图形字幕 (不可提取为文本)
                              </Badge>
                            )}
                          </div>
                          {stream.title && (
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {stream.title}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 右侧：提取设置 */}
        <div className="flex w-80 shrink-0 flex-col justify-between rounded-xl border border-border bg-card p-5">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              提取选项
            </h3>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">导出字幕格式</Label>
              <Select
                value={targetFormat}
                onValueChange={(v: any) => setTargetFormat(v)}
                disabled={isExtracting}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="srt">SRT (SubRip 通用格式)</SelectItem>
                  <SelectItem value="ass">ASS (高级样式格式)</SelectItem>
                  <SelectItem value="vtt">VTT (WebVTT 格式)</SelectItem>
                </SelectContent>
              </Select>
            </div>

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
                  disabled={isExtracting}
                  className="h-8 shrink-0 text-xs px-2.5"
                >
                  {t('changeFolder')}
                </Button>
              </div>
            </div>

            {/* 提取结果展示 */}
            {extractedResult?.success && (
              <div className="space-y-2 rounded-lg bg-green-500/10 border border-green-500/20 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-medium text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" />
                  提取完成！
                </div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {extractedResult.extractedFiles.map((f, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px]">
                      <span className="truncate max-w-[180px]">{f.outputPath.split(/[/\\]/).pop()}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => window.ipc.invoke('toolbox:openFolder', f.outputPath)}
                        className="h-5 w-5 p-0"
                      >
                        <FolderOpen className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-border">
            <Button
              className="w-full text-xs font-medium h-9"
              onClick={handleExtract}
              disabled={streams.length === 0 || selectedIndices.length === 0 || isExtracting}
            >
              {isExtracting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  提取中...
                </>
              ) : (
                `导出所选 (${selectedIndices.length} 条)`
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

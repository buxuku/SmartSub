import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { UploadCloud, FileSearch, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from 'lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import ToolboxFinishBar from '../common/ToolboxFinishBar';
import ToolboxQueueList from '../common/ToolboxQueueList';
import {
  droppedToolboxPaths,
  useToolboxQueue,
} from '../../../hooks/useToolboxQueue';
import type {
  EmbeddedSubtitleStreamInfo,
  ExtractEmbeddedSubtitleResult,
} from '../../../../types/toolbox';

export default function EmbeddedSubtitlePanel() {
  const { t } = useTranslation('toolbox');

  const queueState = useToolboxQueue<
    { filePath: string; selectedIndices?: number[] },
    ExtractEmbeddedSubtitleResult & { exportKey?: string }
  >('toolbox:embeddedSubtitleProgress');
  const { queue, items, running: isExtracting } = queueState;
  const [selectedId, setSelectedId] = useState<string>();
  const selected = items.find((item) => item.id === selectedId) || items[0];
  const videoPath = selected?.filePath;
  const [scans, setScans] = useState<
    Record<string, EmbeddedSubtitleStreamInfo[]>
  >({});
  const [scanError, setScanError] = useState<string>();
  const [isScanning, setIsScanning] = useState(false);
  const streams = videoPath ? scans[videoPath] || [] : [];
  const selectedIndices =
    selected?.input.selectedIndices ??
    streams.filter((stream) => stream.isText).map((stream) => stream.subIndex);
  const [targetFormat, setTargetFormat] = useState<'srt' | 'ass' | 'vtt'>(
    'srt',
  );
  const [outputDir, setOutputDir] = useState('');

  React.useEffect(() => {
    let disposed = false;
    setScanError(undefined);
    setIsScanning(false);
    if (videoPath && !scans[videoPath]) {
      setIsScanning(true);
      window.ipc
        .invoke('toolbox:scanEmbeddedSubtitles', videoPath)
        .then((detected: EmbeddedSubtitleStreamInfo[]) => {
          if (!disposed)
            setScans((previous) => ({ ...previous, [videoPath]: detected }));
        })
        .catch((error) => {
          if (!disposed) setScanError(String(error));
        })
        .finally(() => {
          if (!disposed) setIsScanning(false);
        });
    }
    return () => {
      disposed = true;
    };
  }, [videoPath]);

  const handleSelectVideo = async () => {
    const paths = await window.ipc.invoke('toolbox:selectFile', {
      type: 'video',
      multiSelections: true,
    });
    if (Array.isArray(paths))
      queue.add(paths.map((filePath: string) => ({ filePath })));
  };
  const handleDrop = (event: React.DragEvent) =>
    queue.add(droppedToolboxPaths(event).map((filePath) => ({ filePath })));
  const setSelectedIndices = (indices: number[]) => {
    if (selected)
      queue.updateInput(selected.id, {
        ...selected.input,
        selectedIndices: indices,
      });
  };
  const toggleSelectAll = () => {
    const indices = streams
      .filter((stream) => stream.isText)
      .map((stream) => stream.subIndex);
    setSelectedIndices(
      selectedIndices.length === indices.length ? [] : indices,
    );
  };
  const toggleIndex = (stream: EmbeddedSubtitleStreamInfo) => {
    if (!stream.isText || isExtracting) return;
    setSelectedIndices(
      selectedIndices.includes(stream.subIndex)
        ? selectedIndices.filter((index) => index !== stream.subIndex)
        : [...selectedIndices, stream.subIndex],
    );
  };
  const handleExtract = (retryId?: string) =>
    queue.run(
      {
        failureMessage: t('queue.failed'),
        cancel: (jobId) =>
          window.ipc.invoke('toolbox:cancelEmbeddedSubtitles', jobId),
        execute: async (input, jobId, signal, previous) => {
          const detected: EmbeddedSubtitleStreamInfo[] =
            await window.ipc.invoke(
              'toolbox:scanEmbeddedSubtitles',
              input.filePath,
            );
          signal.throwIfAborted();
          const indices =
            input.selectedIndices ??
            detected
              .filter((stream) => stream.isText)
              .map((stream) => stream.subIndex);
          if (!indices.length) throw new Error(t('queue.noTextTracks'));
          if (
            indices.some(
              (index) =>
                !detected.some(
                  (stream) => stream.subIndex === index && stream.isText,
                ),
            )
          )
            throw new Error(t('queue.invalidTracks'));
          const exportKey = JSON.stringify([targetFormat, outputDir, indices]);
          const retained: ExtractEmbeddedSubtitleResult['extractedFiles'] = [];
          if (previous?.exportKey === exportKey) {
            for (const file of previous.extractedFiles) {
              const response = await window.ipc.invoke('checkFileExists', {
                filePath: file.outputPath,
              });
              if (response?.exists === true) retained.push(file);
            }
          }
          signal.throwIfAborted();
          const remaining = indices.filter(
            (index) => !retained.some((file) => file.subIndex === index),
          );
          if (!remaining.length)
            return { success: true, extractedFiles: retained, exportKey };
          const result: ExtractEmbeddedSubtitleResult = await window.ipc.invoke(
            'toolbox:extractEmbeddedSubtitles',
            {
              videoPath: input.filePath,
              streamIndices: remaining,
              targetFormat,
              outputDir: outputDir || undefined,
            },
            jobId,
          );
          return {
            ...result,
            success: result?.success === true,
            extractedFiles: [...retained, ...(result?.extractedFiles || [])],
            exportKey,
          };
        },
      },
      retryId,
    );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden p-4 gap-4">
        {/* 左侧：视频与字幕轨表格 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-muted/20">
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
              {videoPath
                ? videoPath.split(/[/\\]/).pop()
                : '点击或拖拽 MKV/MP4 视频到此处扫描'}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              快速扫描容器内嵌的 SubRip、ASS、WebVTT、mov_text 软字幕轨
            </p>
          </div>

          <ToolboxQueueList
            {...queueState}
            selectedId={selected?.id}
            onSelect={setSelectedId}
            onRetry={handleExtract}
            onRemove={(id) => queue.remove(id)}
            onCancel={() => void queue.cancel()}
            onClear={() => queue.clear()}
          />
          {scanError && (
            <p
              role="alert"
              className="break-words p-2 text-xs text-destructive"
            >
              {scanError}
            </p>
          )}
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5">
            <span className="text-xs font-medium text-foreground">
              发现字幕轨: {streams.length} 条
            </span>
            {streams.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleSelectAll}
                disabled={isExtracting}
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
              >
                {selectedIndices.length === streams.length
                  ? '取消全选'
                  : '全选'}
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
                <span>
                  {videoPath ? '未发现文本字幕轨' : '请先选择视频文件'}
                </span>
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
                          disabled={!isSelectable || isExtracting}
                          onClick={(event) => event.stopPropagation()}
                          onCheckedChange={() => toggleIndex(stream)}
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground">
                              轨道 #{stream.subIndex + 1}
                            </span>
                            <Badge
                              variant="outline"
                              className="text-[10px] font-mono py-0 h-4"
                            >
                              {stream.codec.toUpperCase()}
                            </Badge>
                            {stream.language && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] py-0 h-4"
                              >
                                {stream.language}
                              </Badge>
                            )}
                            {stream.isDefault && (
                              <Badge className="text-[10px] py-0 h-4 bg-primary/20 text-primary border-transparent">
                                Default
                              </Badge>
                            )}
                            {!isSelectable && (
                              <Badge
                                variant="outline"
                                className="text-[10px] py-0 h-4 border-amber-500/40 text-amber-600 dark:text-amber-400"
                              >
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
        <div className="flex min-h-0 w-72 shrink-0 flex-col gap-4 overflow-y-auto bg-muted/30 p-4">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              提取选项
            </h3>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                导出字幕格式
              </Label>
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
                    const picked = await window.ipc.invoke(
                      'toolbox:selectFolder',
                    );
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
            {items.some((item) => item.result?.extractedFiles?.length) &&
              !isExtracting && (
                <ToolboxFinishBar
                  outputType="subtitle"
                  outputPaths={items.flatMap((item) =>
                    (item.result?.extractedFiles || []).map(
                      (file) => file.outputPath,
                    ),
                  )}
                  summary={t(
                    items.some((item) => item.status !== 'done')
                      ? 'finishBar.partial'
                      : 'finishBar.title',
                  )}
                  onReset={() => queue.clear()}
                />
              )}
          </div>

          <div className="pt-4 border-t border-border">
            <Button
              className="w-full text-xs font-medium h-9"
              onClick={() => void handleExtract()}
              disabled={
                !items.some(
                  (item) =>
                    item.status === 'pending' || item.status === 'cancelled',
                ) || isExtracting
              }
            >
              {isExtracting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  提取中...
                </>
              ) : (
                t('queue.extractAll')
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

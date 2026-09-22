import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { UploadCloud, FileText, Eye, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import ToolboxFinishBar from '../common/ToolboxFinishBar';
import ToolboxQueueList from '../common/ToolboxQueueList';
import {
  droppedToolboxPaths,
  useToolboxQueue,
} from '../../../hooks/useToolboxQueue';
import type {
  SubtitleConvertItemResult,
  ChineseConvertMode,
} from '../../../../types/toolbox';

export default function SubtitleConverterPanel() {
  const { t } = useTranslation('toolbox');

  const queueState = useToolboxQueue<
    { filePath: string },
    SubtitleConvertItemResult
  >();
  const { queue, items: files, running: isProcessing } = queueState;
  const [targetFormat, setTargetFormat] = useState<
    'srt' | 'vtt' | 'ass' | 'lrc' | 'txt'
  >('srt');
  const [targetEncoding, setTargetEncoding] = useState<
    'utf-8' | 'utf-8-bom' | 'gb18030'
  >('utf-8');
  const [chineseMode, setChineseMode] = useState<ChineseConvertMode>('none');
  const [cleanFormatting, setCleanFormatting] = useState(false);
  const [includeTimestampsInTxt, setIncludeTimestampsInTxt] = useState(true);
  const [outputDir, setOutputDir] = useState<string>('');

  // 预览弹窗状态
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{
    fileName: string;
    encoding: string;
    format: string;
    cues: Array<{ startMs: number; endMs: number; text: string }>;
  } | null>(null);

  const [encodings, setEncodings] = useState<Record<string, string>>({});
  const addFiles = async (paths: string[]) => {
    if (queue.getSnapshot().running) return;
    queue.add(paths.map((filePath) => ({ filePath })));
    for (const filePath of Array.from(new Set(paths))) {
      try {
        const result = await window.ipc.invoke(
          'toolbox:detectEncoding',
          filePath,
        );
        if (result?.encoding)
          setEncodings((previous) => ({
            ...previous,
            [filePath]: result.encoding,
          }));
      } catch {
        // Processing reports file errors on the corresponding queue item.
      }
    }
  };

  // 点击选择文件
  const handleSelectFiles = async () => {
    try {
      const selected = await window.ipc.invoke('toolbox:selectFile', {
        type: 'subtitle',
        multiSelections: true,
      });
      if (Array.isArray(selected) && selected.length > 0) {
        await addFiles(selected);
      }
    } catch (err) {
      console.error('Select file error:', err);
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    void addFiles(droppedToolboxPaths(event));
  };
  const clearFiles = () => queue.clear();

  // 选择自定义输出目录
  const handleSelectOutputDir = async () => {
    try {
      const picked = await window.ipc.invoke('toolbox:selectFolder');
      if (picked) {
        setOutputDir(picked);
      }
    } catch (err) {
      console.error('Select folder error:', err);
    }
  };

  // 预览字幕
  const handlePreview = async (filePath: string, fileName: string) => {
    setPreviewLoading(true);
    setPreviewOpen(true);
    try {
      const res = await window.ipc.invoke('toolbox:previewSubtitle', {
        filePath,
        limit: 5,
      });
      setPreviewData({
        fileName,
        encoding: res.encoding,
        format: res.format,
        cues: res.cues || [],
      });
    } catch (err) {
      toast.error(String(err));
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleConvertAll = (retryId?: string) =>
    queue.run(
      {
        failureMessage: t('queue.failed'),
        execute: ({ filePath }) =>
          window.ipc.invoke('toolbox:convertSubtitleFile', {
            filePath,
            targetFormat,
            targetEncoding,
            chineseConversion: chineseMode,
            cleanFormatting,
            includeTimestampsInTxt,
            outputDir: outputDir || undefined,
          }),
      },
      retryId,
    );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden p-4 gap-4">
        {/* 左侧：文件列表与拖拽上传区 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-muted/20">
          {/* 拖拽吸附区 */}
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
              {t('dropFilesHere')}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              支持 SRT, VTT, ASS, SSA, LRC, TXT 等任意字幕格式，自动修正
              ANSI/GBK 乱码
            </p>
          </div>

          {/* 文件列表头部 */}
          <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5">
            <span className="text-xs font-medium text-foreground">
              {t('subtitleConverter.fileCount', { count: files.length })}
            </span>
            {files.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFiles}
                disabled={isProcessing}
                className="h-7 text-xs text-muted-foreground hover:text-destructive"
              >
                {t('subtitleConverter.clearList')}
              </Button>
            )}
          </div>

          {/* 文件滚动列表 */}
          <div className="flex-1 overflow-y-auto divide-y divide-border/60">
            {files.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center text-center text-xs text-muted-foreground">
                <FileText className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <span>暂无待转换的字幕文件</span>
              </div>
            ) : (
              <ToolboxQueueList
                {...queueState}
                onRetry={handleConvertAll}
                onRemove={(id) => queue.remove(id)}
                onCancel={() => void queue.cancel()}
                onClear={clearFiles}
                renderInfo={(file) =>
                  encodings[file.filePath] ? (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {encodings[file.filePath]}
                    </span>
                  ) : null
                }
                renderActions={(file) => (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    title={t('subtitleConverter.previewTitle')}
                    aria-label={t('subtitleConverter.previewTitle')}
                    onClick={() => handlePreview(file.filePath, file.fileName)}
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                )}
              />
            )}
          </div>
        </div>

        {/* 右侧：转换配置面板 */}
        <div className="flex min-h-0 w-72 shrink-0 flex-col gap-4 overflow-y-auto bg-muted/30 p-4">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              转换设置
            </h3>

            {/* 目标格式 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('subtitleConverter.targetFormat')}
              </Label>
              <Select
                value={targetFormat}
                onValueChange={(v: any) => setTargetFormat(v)}
                disabled={isProcessing}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="srt">SRT (SubRip - 通用标准)</SelectItem>
                  <SelectItem value="vtt">VTT (WebVTT - 网页流媒体)</SelectItem>
                  <SelectItem value="ass">ASS (高级样式字幕)</SelectItem>
                  <SelectItem value="lrc">LRC (歌词格式)</SelectItem>
                  <SelectItem value="txt">TXT (纯文本)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 目标编码 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('subtitleConverter.targetEncoding')}
              </Label>
              <Select
                value={targetEncoding}
                onValueChange={(v: any) => setTargetEncoding(v)}
                disabled={isProcessing}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="utf-8">UTF-8 (标准推荐)</SelectItem>
                  <SelectItem value="utf-8-bom">
                    UTF-8 with BOM (兼容旧播放器)
                  </SelectItem>
                  <SelectItem value="gb18030">
                    GB18030 / ANSI (Windows 专用)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 简繁转换 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t('subtitleConverter.chineseConversion')}
              </Label>
              <Select
                value={chineseMode}
                onValueChange={(v: any) => setChineseMode(v)}
                disabled={isProcessing}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {t('subtitleConverter.chineseNone')}
                  </SelectItem>
                  <SelectItem value="s2t">
                    {t('subtitleConverter.chineseS2T')}
                  </SelectItem>
                  <SelectItem value="t2s">
                    {t('subtitleConverter.chineseT2S')}
                  </SelectItem>
                  <SelectItem value="s2tw">
                    {t('subtitleConverter.chineseS2TW')}
                  </SelectItem>
                  <SelectItem value="tw2s">
                    {t('subtitleConverter.chineseTW2S')}
                  </SelectItem>
                  <SelectItem value="s2hk">
                    {t('subtitleConverter.chineseS2HK')}
                  </SelectItem>
                  <SelectItem value="hk2s">
                    {t('subtitleConverter.chineseHK2S')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* 样式标签清洗 */}
            <div className="flex items-center justify-between pt-1">
              <div className="space-y-0.5">
                <Label className="text-xs text-foreground">
                  {t('subtitleConverter.cleanFormatting')}
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  去除 ASS 特效及 HTML 字体颜色代码
                </p>
              </div>
              <Switch
                checked={cleanFormatting}
                onCheckedChange={setCleanFormatting}
                disabled={isProcessing}
              />
            </div>

            {/* TXT 是否保留时间戳 */}
            {targetFormat === 'txt' && (
              <div className="flex items-center justify-between pt-1">
                <div className="space-y-0.5">
                  <Label className="text-xs text-foreground">
                    保留时间轴标记
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    在纯文本中保留每句的起止时间
                  </p>
                </div>
                <Switch
                  checked={includeTimestampsInTxt}
                  onCheckedChange={setIncludeTimestampsInTxt}
                  disabled={isProcessing}
                />
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
            {/* 转换完成行动条 */}
            {files.some((f) => f.status === 'done' && f.result?.outputPath) &&
              !isProcessing && (
                <ToolboxFinishBar
                  outputType="subtitle"
                  outputPaths={files
                    .filter((f) => f.status === 'done' && f.result?.outputPath)
                    .map((f) => f.result!.outputPath!)}
                  summary={t('finishBar.title')}
                  onReset={clearFiles}
                />
              )}
          </div>

          {/* 底部转换执行按钮 */}
          <div className="pt-4 border-t border-border">
            <Button
              className="w-full text-xs font-medium h-9"
              onClick={() => void handleConvertAll()}
              disabled={
                !files.some(
                  (f) => f.status === 'pending' || f.status === 'cancelled',
                ) || isProcessing
              }
            >
              {isProcessing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('processing')}
                </>
              ) : (
                t('subtitleConverter.batchAction')
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* 字幕预览弹窗 */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              {previewData?.fileName || '字幕预览'}
            </DialogTitle>
          </DialogHeader>

          {previewLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  探测格式:{' '}
                  <b className="text-foreground">
                    {previewData?.format?.toUpperCase()}
                  </b>
                </span>
                <span>•</span>
                <span>
                  检测编码:{' '}
                  <b className="text-foreground">{previewData?.encoding}</b>
                </span>
              </div>

              <div className="max-h-64 overflow-y-auto space-y-2 rounded-lg border border-border bg-muted/30 p-3 font-mono text-[11px]">
                {previewData?.cues?.length === 0 ? (
                  <p className="text-muted-foreground text-center py-4">
                    无条目内容
                  </p>
                ) : (
                  previewData?.cues?.map((cue, idx) => (
                    <div
                      key={idx}
                      className="border-b border-border/50 pb-1.5 last:border-none"
                    >
                      <div className="text-primary/70 text-[10px]">
                        #{idx + 1} ({Math.round(cue.startMs / 1000)}s -{' '}
                        {Math.round(cue.endMs / 1000)}s)
                      </div>
                      <div className="text-foreground whitespace-pre-wrap">
                        {cue.text}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPreviewOpen(false)}
              className="text-xs"
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

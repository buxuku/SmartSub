import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'next-i18next';
import ReactPlayer from 'react-player';
import { Film, Sparkles } from 'lucide-react';
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
import ToolboxFinishBar from '../common/ToolboxFinishBar';
import ToolboxQueueList from '../common/ToolboxQueueList';
import {
  droppedToolboxPaths,
  useToolboxQueue,
} from '../../../hooks/useToolboxQueue';
import {
  resolveToolboxVideoRange,
  ToolboxVideoInput,
  useToolboxVideoSelection,
} from '../../../hooks/useToolboxVideoSelection';
import type { VideoToGifResult } from '../../../../types/toolbox';

export default function VideoToGifPanel() {
  const { t } = useTranslation('toolbox');

  const playerRef = useRef<ReactPlayer>(null);

  const queueState = useToolboxQueue<ToolboxVideoInput, VideoToGifResult>(
    'toolbox:gifProgress',
  );
  const { queue, items, running: isExporting } = queueState;
  const selection = useToolboxVideoSelection(queue, items, 5);
  const { videoPath, startSec, endSec, setStartSec, setEndSec } = selection;
  const [currentTime, setCurrentTime] = useState(0);
  useEffect(() => setCurrentTime(0), [selection.selectedId]);
  const [fps, setFps] = useState(12);
  const [width, setWidth] = useState(480);
  const [outputDir, setOutputDir] = useState('');
  const progress =
    items.find((item) => item.status === 'running')?.progress || 0;

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
  const handleStartGif = (retryId?: string) =>
    queue.run(
      {
        failureMessage: t('queue.failed'),
        cancel: (jobId) => window.ipc.invoke('toolbox:cancelVideoToGif', jobId),
        execute: async (input, jobId, signal) => {
          const range = await resolveToolboxVideoRange(input, 5);
          signal.throwIfAborted();
          return window.ipc.invoke('toolbox:videoToGif', {
            jobId,
            config: {
              videoPath: input.filePath,
              startSec: range.startSec,
              endSec: range.endSec,
              fps,
              width,
              outputPath: outputDir
                ? `${outputDir}/${input.filePath
                    .split(/[/\\]/)
                    .pop()!
                    .replace(/\.[^.]+$/, '')}_anim.gif`
                : undefined,
            },
          });
        },
      },
      retryId,
    );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden p-4 gap-4">
        {/* 左侧：播放器与时间区间 */}
        <div
          className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background"
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          {items.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={isExporting}
              onClick={handleSelectVideo}
            >
              {t('videoCompressorQueue.addFiles')}
            </Button>
          )}
          <ToolboxQueueList
            {...queueState}
            selectedId={selection.selectedId}
            onSelect={selection.select}
            onRetry={handleStartGif}
            onRemove={(id) => queue.remove(id)}
            onCancel={() => void queue.cancel()}
            onClear={() => queue.clear()}
          />
          {selection.loadError && (
            <p role="alert" className="p-2 text-xs text-destructive">
              {selection.loadError}
            </p>
          )}
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
            <div className="flex flex-none flex-col">
              <div className="relative aspect-video min-h-48 bg-black flex items-center justify-center overflow-hidden">
                <ReactPlayer
                  key={videoPath}
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
                      disabled={isExporting || currentTime >= endSec}
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
                      disabled={isExporting || currentTime <= startSec}
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
        <div className="flex min-h-0 w-72 shrink-0 flex-col gap-4 overflow-y-auto bg-muted/30 p-4">
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Sparkles className="h-4 w-4 text-primary" />
              动图参数
            </h3>

            {/* 帧率 */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                动图帧率 (FPS)
              </Label>
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
              <Label className="text-xs text-muted-foreground">
                动图宽度 (等比缩放)
              </Label>
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
              💡 采用双通道 PaletteGen 调色板渲染算法，避免传统 GIF
              出现的彩点噪点和严重色斑。
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
                    const picked = await window.ipc.invoke(
                      'toolbox:selectFolder',
                    );
                    if (picked) setOutputDir(picked);
                  }}
                  disabled={isExporting}
                  className="h-8 shrink-0 text-xs px-2.5"
                >
                  {t('changeFolder')}
                </Button>
              </div>
            </div>

            {items.some((item) => item.status === 'done') && !isExporting && (
              <ToolboxFinishBar
                outputType="gif"
                outputPaths={items
                  .filter((item) => item.status === 'done')
                  .map((item) => item.result!.outputPath)}
                summary={t('finishBar.title')}
                onReset={() => queue.clear()}
              />
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
                onClick={() => void handleStartGif()}
                disabled={
                  !items.some(
                    (item) =>
                      item.status === 'pending' || item.status === 'cancelled',
                  )
                }
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

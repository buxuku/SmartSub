import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { UploadCloud, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ToolboxFinishBar from '../common/ToolboxFinishBar';
import ToolboxQueueList from '../common/ToolboxQueueList';
import {
  droppedToolboxPaths,
  useToolboxQueue,
} from '../../../hooks/useToolboxQueue';
import { FRAMERATE_RATIO_PRESETS } from '@/lib/framerates';
import type {
  SubtitleSyncMode,
  SubtitleSyncResult,
} from '../../../../types/toolbox';

export default function SubtitleSyncPanel() {
  const { t } = useTranslation('toolbox');

  const queueState = useToolboxQueue<
    { filePath: string },
    SubtitleSyncResult
  >();
  const { queue, items, running: isProcessing } = queueState;
  const [mode, setMode] = useState<SubtitleSyncMode>('offset');

  const [offsetMs, setOffsetMs] = useState<number>(0);
  const [scaleRatio, setScaleRatio] = useState<number>(1.0);

  const [p1SourceMs, setP1SourceMs] = useState<number>(1000);
  const [p1TargetMs, setP1TargetMs] = useState<number>(1000);
  const [p2SourceMs, setP2SourceMs] = useState<number>(60000);
  const [p2TargetMs, setP2TargetMs] = useState<number>(60000);

  const [outputDir, setOutputDir] = useState<string>('');

  const handleSelectFile = async () => {
    const files = await window.ipc.invoke('toolbox:selectFile', {
      type: 'subtitle',
      multiSelections: true,
    });
    if (Array.isArray(files) && files.length > 0) {
      queue.add(files.map((filePath: string) => ({ filePath })));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    queue.add(droppedToolboxPaths(e).map((filePath) => ({ filePath })));
  };

  const handleApplySync = (retryId?: string) =>
    queue.run(
      {
        failureMessage: t('queue.failed'),
        execute: ({ filePath }) =>
          window.ipc.invoke('toolbox:syncSubtitleTime', {
            filePath,
            mode,
            offsetMs,
            scaleRatio,
            scaleFraction: FRAMERATE_RATIO_PRESETS.find(
              (preset) => preset.ratio === scaleRatio,
            )?.fraction,
            p1SourceMs,
            p1TargetMs,
            p2SourceMs,
            p2TargetMs,
            outputPath: outputDir
              ? `${outputDir}/${filePath
                  .split(/[/\\]/)
                  .pop()!
                  .replace(/(\.[^.]+)$/, '_synced$1')}`
              : undefined,
          }),
      },
      retryId,
    );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden p-4 gap-4">
        {/* 左侧：文件选择与操作模式 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background p-4 gap-4">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={handleSelectFile}
            className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-6 transition-colors hover:bg-muted/50 cursor-pointer"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UploadCloud className="h-6 w-6" />
            </div>
            <p className="mt-2 text-xs font-medium text-foreground">
              点击或拖拽需要校准时间轴的字幕文件到此处
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              支持 SRT, VTT, ASS 格式，修复整篇字幕提前、滞后或帧率漂移
            </p>
          </div>

          <ToolboxQueueList
            {...queueState}
            onRetry={handleApplySync}
            onRemove={(id) => queue.remove(id)}
            onCancel={() => void queue.cancel()}
            onClear={() => queue.clear()}
          />
          <fieldset disabled={isProcessing} className="space-y-4">
            <Label className="text-xs font-semibold text-foreground">
              校准模式
            </Label>
            <Tabs
              value={mode}
              onValueChange={(v: any) => setMode(v)}
              className="w-full"
            >
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="offset" className="text-xs">
                  整体平移
                </TabsTrigger>
                <TabsTrigger value="scale" className="text-xs">
                  帧率伸缩
                </TabsTrigger>
                <TabsTrigger value="two-point" className="text-xs">
                  双锚点校正
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {/* 整体平移内容 */}
            {mode === 'offset' && (
              <div className="space-y-3 rounded-lg border border-border p-4 bg-muted/20">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-foreground">
                    平移毫秒数 (正数延后，负数提前)
                  </Label>
                  <span className="font-mono text-xs font-medium text-primary">
                    {offsetMs >= 0 ? `+${offsetMs}` : offsetMs} ms (
                    {(offsetMs / 1000).toFixed(3)}s)
                  </span>
                </div>
                <Input
                  type="number"
                  step="100"
                  value={offsetMs}
                  onChange={(e) =>
                    setOffsetMs(parseInt(e.target.value, 10) || 0)
                  }
                  className="h-8 text-xs font-mono"
                />
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[11px] text-muted-foreground mr-1">
                    快捷微调:
                  </span>
                  {[
                    { label: '-1s', delta: -1000 },
                    { label: '-500ms', delta: -500 },
                    { label: '-100ms', delta: -100 },
                    { label: '归零', reset: 0 },
                    { label: '+100ms', delta: 100 },
                    { label: '+500ms', delta: 500 },
                    { label: '+1s', delta: 1000 },
                  ].map((btn, idx) => (
                    <Button
                      key={idx}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        btn.reset !== undefined
                          ? setOffsetMs(0)
                          : setOffsetMs((v) => v + (btn.delta || 0))
                      }
                      className="h-6 text-[11px] px-2"
                    >
                      {btn.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {/* 比例伸缩内容 */}
            {mode === 'scale' && (
              <div className="space-y-3 rounded-lg border border-border p-4 bg-muted/20">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-foreground">
                    时间轴伸缩比率
                  </Label>
                  <span className="font-mono text-xs font-medium text-primary">
                    {scaleRatio.toFixed(5)}x
                  </span>
                </div>
                <Input
                  type="number"
                  step="0.001"
                  value={scaleRatio}
                  onChange={(e) =>
                    setScaleRatio(parseFloat(e.target.value) || 1.0)
                  }
                  className="h-8 text-xs font-mono"
                />
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[11px] text-muted-foreground mr-1">
                    常用帧率校准预设:
                  </span>
                  {FRAMERATE_RATIO_PRESETS.map((preset, idx) => (
                    <Button
                      key={idx}
                      variant="outline"
                      size="sm"
                      onClick={() => setScaleRatio(preset.ratio)}
                      className="h-6 text-[11px] px-2"
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {/* 双锚点内容 */}
            {mode === 'two-point' && (
              <div className="space-y-3 rounded-lg border border-border p-4 bg-muted/20">
                <p className="text-[11px] text-muted-foreground leading-normal">
                  分别输入第一句和最后一句当前的时间码与正确的目标时间码，算法将通过线性重采样修正全篇渐进式偏差。
                </p>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="space-y-1">
                    <span className="text-muted-foreground text-[11px]">
                      首句原时间 (ms)
                    </span>
                    <Input
                      type="number"
                      value={p1SourceMs}
                      onChange={(e) =>
                        setP1SourceMs(parseInt(e.target.value, 10) || 0)
                      }
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="text-muted-foreground text-[11px]">
                      首句目标时间 (ms)
                    </span>
                    <Input
                      type="number"
                      value={p1TargetMs}
                      onChange={(e) =>
                        setP1TargetMs(parseInt(e.target.value, 10) || 0)
                      }
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="text-muted-foreground text-[11px]">
                      尾句原时间 (ms)
                    </span>
                    <Input
                      type="number"
                      value={p2SourceMs}
                      onChange={(e) =>
                        setP2SourceMs(parseInt(e.target.value, 10) || 0)
                      }
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="text-muted-foreground text-[11px]">
                      尾句目标时间 (ms)
                    </span>
                    <Input
                      type="number"
                      value={p2TargetMs}
                      onChange={(e) =>
                        setP2TargetMs(parseInt(e.target.value, 10) || 0)
                      }
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                </div>
              </div>
            )}
          </fieldset>
        </div>

        {/* 右侧：保存控制与执行 */}
        <div className="flex min-h-0 w-72 shrink-0 flex-col gap-4 overflow-y-auto bg-muted/30 p-4">
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
                  disabled={isProcessing}
                  className="h-8 shrink-0 text-xs px-2.5"
                >
                  {t('changeFolder')}
                </Button>
              </div>
            </div>

            {items.some((item) => item.status === 'done') && !isProcessing && (
              <ToolboxFinishBar
                outputType="subtitle"
                outputPaths={items
                  .filter((item) => item.status === 'done')
                  .map((item) => item.result!.outputPath)}
                summary={t('finishBar.title')}
                onReset={() => queue.clear()}
              />
            )}
          </div>

          <div className="pt-4 border-t border-border">
            <Button
              className="w-full text-xs font-medium h-9"
              onClick={() => void handleApplySync()}
              disabled={
                !items.some(
                  (item) =>
                    item.status === 'pending' || item.status === 'cancelled',
                ) || isProcessing
              }
            >
              {isProcessing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  校准中...
                </>
              ) : (
                '应用校准并导出'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

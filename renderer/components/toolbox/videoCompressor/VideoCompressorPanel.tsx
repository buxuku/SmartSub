import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { UploadCloud, Minimize2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import ToolboxFinishBar from '../common/ToolboxFinishBar';
import ToolboxQueueList from '../common/ToolboxQueueList';
import {
  droppedToolboxPaths,
  useToolboxQueue,
} from '../../../hooks/useToolboxQueue';
import type {
  VideoCompressPreset,
  VideoCompressResult,
} from '../../../../types/toolbox';

export default function VideoCompressorPanel() {
  const { t } = useTranslation('toolbox');

  const queueState = useToolboxQueue<{ filePath: string }, VideoCompressResult>(
    'toolbox:compressProgress',
  );
  const { queue, items: files, running: isCompressing } = queueState;
  const [preset, setPreset] = useState<VideoCompressPreset>('wechat_25mb');
  const [targetSizeMb, setTargetSizeMb] = useState<number>(24);
  const [outputDir, setOutputDir] = useState<string>('');

  const addFilesToQueue = (filePaths: string[]) => {
    queue.add(filePaths.map((filePath) => ({ filePath })));
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
    addFilesToQueue(droppedToolboxPaths(e));
  };

  const handleStartCompress = (retryId?: string) =>
    queue.run(
      {
        failureMessage: t('queue.failed'),
        cancel: (jobId) =>
          window.ipc.invoke('toolbox:cancelCompressVideo', jobId),
        execute: ({ filePath }, jobId) =>
          window.ipc.invoke('toolbox:compressVideo', {
            jobId,
            config: {
              videoPath: filePath,
              preset,
              targetSizeMb,
              outputPath: outputDir
                ? `${outputDir}/${filePath
                    .split(/[/\\]/)
                    .pop()!
                    .replace(/\.[^.]+$/, '')}_compressed.mp4`
                : undefined,
            },
          }),
      },
      retryId,
    );

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
      <div className="flex min-h-0 flex-1 overflow-hidden p-4 gap-4">
        {/* 左侧：文件列表与档位 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background p-4 gap-4">
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

          <ToolboxQueueList
            {...queueState}
            renderInfo={(item) =>
              item.result?.skipped ? (
                <p className="text-xs text-muted-foreground">
                  {t('videoCompressorQueue.skipped')}
                </p>
              ) : null
            }
            onRetry={handleStartCompress}
            onRemove={(id) => queue.remove(id)}
            onCancel={() => void queue.cancel()}
            onClear={() => queue.clear()}
          />

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
                summary={t('videoCompressorQueue.finished', {
                  count: doneItems.length,
                  skipped: doneItems.filter((item) => item.result?.skipped)
                    .length,
                })}
                stats={{
                  originalSize: totalOriginal,
                  compressedSize: totalCompressed,
                }}
                onReset={() => queue.clear()}
              />
            )}
          </div>

          <div className="pt-4 border-t border-border space-y-2">
            {isCompressing ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {t('videoCompressorQueue.compressingItem', {
                      current:
                        files.findIndex((file) => file.status === 'running') +
                        1,
                      total: files.length,
                    })}
                  </span>
                  <span className="font-mono font-medium">
                    {Math.round(
                      files.find((file) => file.status === 'running')
                        ?.progress || 0,
                    )}
                    %
                  </span>
                </div>
                <Progress
                  value={
                    files.find((file) => file.status === 'running')?.progress ||
                    0
                  }
                  className="h-1.5"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void queue.cancel()}
                  disabled={queueState.cancelling}
                  className="w-full h-8 text-xs text-destructive hover:text-destructive"
                >
                  {t('cancel')}
                </Button>
              </div>
            ) : (
              <Button
                className="w-full text-xs font-medium h-9"
                onClick={() => void handleStartCompress()}
                disabled={
                  !files.some(
                    (file) =>
                      file.status === 'pending' || file.status === 'cancelled',
                  )
                }
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

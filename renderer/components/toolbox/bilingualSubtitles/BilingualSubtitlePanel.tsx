import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  UploadCloud,
  Languages,
  Loader2,
  Sparkles,
  ArrowUpDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import ToolboxFinishBar from '../common/ToolboxFinishBar';
import ToolboxQueueList from '../common/ToolboxQueueList';
import {
  droppedToolboxPaths,
  useToolboxQueue,
} from '../../../hooks/useToolboxQueue';
import type { BilingualSubtitleResult } from '../../../../types/toolbox';

export default function BilingualSubtitlePanel() {
  const { t } = useTranslation('toolbox');

  const [action, setAction] = useState<'merge' | 'split'>('merge');

  const mergeState = useToolboxQueue<
    { filePath: string; secondaryPath?: string },
    BilingualSubtitleResult
  >();
  const splitState = useToolboxQueue<
    { filePath: string },
    BilingualSubtitleResult
  >();
  const activeState = action === 'merge' ? mergeState : splitState;
  const { queue, items, running: isProcessing } = activeState;
  const [secondaryPaths, setSecondaryPaths] = useState<string[]>([]);
  const [position, setPosition] = useState<'top' | 'bottom'>('top');
  const [outputDir, setOutputDir] = useState('');
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [isDraggingPrimary, setIsDraggingPrimary] = useState(false);
  const [isDraggingSecondary, setIsDraggingSecondary] = useState(false);

  const addFiles = (
    paths: string[],
    type: 'primary' | 'secondary' | 'split',
  ) => {
    if (isProcessing) return;
    const valid = paths.filter((path) =>
      /\.(srt|vtt|ass|ssa|sub)$/i.test(path),
    );
    if (valid.length !== paths.length) toast.error(t('queue.invalidSubtitles'));
    if (type === 'secondary')
      setSecondaryPaths((previous) =>
        Array.from(new Set([...previous, ...valid])),
      );
    else if (type === 'primary')
      mergeState.queue.add(valid.map((filePath) => ({ filePath })));
    else splitState.queue.add(valid.map((filePath) => ({ filePath })));
  };
  const selectFile = async (type: 'primary' | 'secondary' | 'split') => {
    const paths = await window.ipc.invoke('toolbox:selectFile', {
      type: 'subtitle',
      multiSelections: true,
    });
    if (Array.isArray(paths)) addFiles(paths, type);
  };
  const handleDropFile = (
    event: React.DragEvent,
    type: 'primary' | 'secondary' | 'split',
  ) => {
    setIsDraggingSplit(false);
    setIsDraggingPrimary(false);
    setIsDraggingSecondary(false);
    addFiles(droppedToolboxPaths(event), type);
  };
  const handleStart = (retryId?: string) => {
    if (action === 'split')
      return splitState.queue.run(
        {
          failureMessage: t('queue.failed'),
          execute: ({ filePath }) =>
            window.ipc.invoke('toolbox:splitBilingualSubtitles', {
              filePath,
              outputDir: outputDir || undefined,
            }),
        },
        retryId,
      );
    return mergeState.queue.run(
      {
        failureMessage: t('queue.failed'),
        execute: (input) => {
          const secondaryPath =
            input.secondaryPath ||
            (mergeState.items.length === 1 && secondaryPaths.length === 1
              ? secondaryPaths[0]
              : undefined);
          if (!secondaryPath) throw new Error(t('queue.choosePair'));
          return window.ipc.invoke('toolbox:mergeBilingualSubtitles', {
            primaryPath: input.filePath,
            secondaryPath,
            primaryPosition: position,
            outputPath: outputDir
              ? `${outputDir}/${input.filePath
                  .split(/[/\\]/)
                  .pop()!
                  .replace(/\.[^.]+$/, '')}_bilingual.srt`
              : undefined,
          });
        },
      },
      retryId,
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden p-4 gap-4">
        {/* 左侧：操作面板 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background p-4 gap-4">
          <Tabs
            value={action}
            onValueChange={(v: any) => {
              setAction(v);
            }}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger
                value="merge"
                className="text-xs"
                disabled={isProcessing}
              >
                两份单语字幕合并为双语
              </TabsTrigger>
              <TabsTrigger
                value="split"
                className="text-xs"
                disabled={isProcessing}
              >
                一份双语字幕拆分为单语
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {action === 'merge' ? (
            <div className="space-y-4">
              {/* 主字幕 */}
              <div className="space-y-1.5">
                <Label className="text-xs text-foreground">
                  主字幕 (上层 / 原语言)
                </Label>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => selectFile('primary')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectFile('primary');
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDraggingPrimary(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setIsDraggingPrimary(false);
                  }}
                  onDrop={(e) => handleDropFile(e, 'primary')}
                  className={`flex items-center justify-between rounded-lg border border-dashed p-4 transition-colors cursor-pointer ${
                    isDraggingPrimary
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-muted/40'
                  }`}
                >
                  <div className="flex items-center gap-3 truncate">
                    <Languages className="h-5 w-5 text-primary shrink-0" />
                    <span className="text-xs truncate font-medium text-foreground">
                      {mergeState.items.length
                        ? t('queue.files', { count: mergeState.items.length })
                        : '点击或拖拽主字幕文件 (.srt / .vtt / .ass)'}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 text-xs">
                    浏览
                  </Button>
                </div>
              </div>

              {/* 次字幕 */}
              <div className="space-y-1.5">
                <Label className="text-xs text-foreground">
                  次字幕 (下层 / 译文)
                </Label>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => selectFile('secondary')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectFile('secondary');
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDraggingSecondary(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setIsDraggingSecondary(false);
                  }}
                  onDrop={(e) => handleDropFile(e, 'secondary')}
                  className={`flex items-center justify-between rounded-lg border border-dashed p-4 transition-colors cursor-pointer ${
                    isDraggingSecondary
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:bg-muted/40'
                  }`}
                >
                  <div className="flex items-center gap-3 truncate">
                    <Languages className="h-5 w-5 text-primary/70 shrink-0" />
                    <span className="text-xs truncate font-medium text-foreground">
                      {secondaryPaths.length
                        ? t('queue.files', { count: secondaryPaths.length })
                        : '点击或拖拽次字幕文件 (.srt / .vtt / .ass)'}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 text-xs">
                    浏览
                  </Button>
                </div>
              </div>

              {/* 排列顺序 */}
              <div className="space-y-1.5 pt-2">
                <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  双语字幕上下层排布
                </Label>
                <Select
                  value={position}
                  onValueChange={(v: any) => setPosition(v)}
                  disabled={isProcessing}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="top">
                      主语言在上方，次语言在下方 (推荐)
                    </SelectItem>
                    <SelectItem value="bottom">
                      次语言在上方，主语言在下方
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <Label className="text-xs text-foreground">双语字幕源文件</Label>
              <div
                role="button"
                tabIndex={0}
                onClick={() => selectFile('split')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectFile('split');
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDraggingSplit(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setIsDraggingSplit(false);
                }}
                onDrop={(e) => handleDropFile(e, 'split')}
                className={`flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center transition-colors cursor-pointer ${
                  isDraggingSplit
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:bg-muted/40'
                }`}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <UploadCloud className="h-6 w-6" />
                </div>
                <p className="mt-2 text-xs font-medium text-foreground">
                  {splitState.items.length
                    ? t('queue.files', { count: splitState.items.length })
                    : '点击或拖拽包含两行文字的双语字幕文件'}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  自动将每条字幕中的两行文本拆解为 Part 1 与 Part 2 独立文件
                </p>
              </div>
            </div>
          )}
          <ToolboxQueueList
            {...activeState}
            onRetry={handleStart}
            onRemove={(id) => queue.remove(id)}
            onCancel={() => void queue.cancel()}
            onClear={() => {
              queue.clear();
              if (action === 'merge') setSecondaryPaths([]);
            }}
            renderInfo={
              action === 'merge'
                ? (item) => {
                    const input = mergeState.items.find(
                      (entry) => entry.id === item.id,
                    )?.input;
                    return (
                      <Select
                        disabled={isProcessing}
                        value={
                          input?.secondaryPath ||
                          (mergeState.items.length === 1 &&
                          secondaryPaths.length === 1
                            ? secondaryPaths[0]
                            : '')
                        }
                        onValueChange={(secondaryPath) => {
                          if (input)
                            mergeState.queue.updateInput(item.id, {
                              ...input,
                              secondaryPath,
                            });
                        }}
                      >
                        <SelectTrigger
                          className="mt-1 h-8 w-full min-w-0 text-xs"
                          aria-label={t('queue.choosePair')}
                        >
                          <SelectValue placeholder={t('queue.choosePair')} />
                        </SelectTrigger>
                        <SelectContent>
                          {secondaryPaths.map((path) => (
                            <SelectItem key={path} value={path}>
                              {path.split(/[/\\]/).pop()}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    );
                  }
                : undefined
            }
          />
        </div>

        {/* 右侧：保存控制 */}
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
                  .flatMap((item) => item.result!.outputPaths)}
                summary={t('finishBar.title')}
                onReset={() => {
                  queue.clear();
                  if (action === 'merge') setSecondaryPaths([]);
                }}
              />
            )}
          </div>

          <div className="pt-4 border-t border-border">
            <Button
              className="w-full text-xs font-medium h-9"
              onClick={() => void handleStart()}
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
                  处理中...
                </>
              ) : action === 'merge' ? (
                '合并为双语字幕'
              ) : (
                '拆分为两份单语'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

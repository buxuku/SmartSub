import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  UploadCloud,
  Languages,
  CheckCircle2,
  FolderOpen,
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
import type { BilingualSubtitleResult } from '../../../../types/toolbox';

export default function BilingualSubtitlePanel() {
  const { t } = useTranslation('toolbox');

  const [action, setAction] = useState<'merge' | 'split'>('merge');

  // 合并模式参数
  const [primaryPath, setPrimaryPath] = useState<string>('');
  const [secondaryPath, setSecondaryPath] = useState<string>('');
  const [position, setPosition] = useState<'top' | 'bottom'>('top');

  // 拆分模式参数
  const [splitPath, setSplitPath] = useState<string>('');

  const [outputDir, setOutputDir] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [result, setResult] = useState<BilingualSubtitleResult | null>(null);

  const selectFile = async (type: 'primary' | 'secondary' | 'split') => {
    const files = await window.ipc.invoke('toolbox:selectFile', {
      type: 'subtitle',
      multiSelections: false,
    });
    if (Array.isArray(files) && files.length > 0) {
      if (type === 'primary') setPrimaryPath(files[0]);
      else if (type === 'secondary') setSecondaryPath(files[0]);
      else setSplitPath(files[0]);
      setResult(null);
    }
  };

  const handleStart = async () => {
    setIsProcessing(true);
    setResult(null);

    try {
      if (action === 'merge') {
        if (!primaryPath || !secondaryPath) {
          toast.error('请同时选择主语言和次语言字幕');
          setIsProcessing(false);
          return;
        }
        const res: BilingualSubtitleResult = await window.ipc.invoke(
          'toolbox:mergeBilingualSubtitles',
          {
            primaryPath,
            secondaryPath,
            primaryPosition: position,
            outputPath: outputDir
              ? `${outputDir}/${primaryPath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '')}_bilingual.srt`
              : undefined,
          },
        );
        setResult(res);
        if (res.success) toast.success('双语合并完成！');
        else toast.error(`合并失败: ${res.error}`);
      } else {
        if (!splitPath) {
          toast.error('请选择需要拆分的双语字幕文件');
          setIsProcessing(false);
          return;
        }
        const res: BilingualSubtitleResult = await window.ipc.invoke(
          'toolbox:splitBilingualSubtitles',
          {
            filePath: splitPath,
            outputDir: outputDir || undefined,
          },
        );
        setResult(res);
        if (res.success) toast.success('拆分完成，已导出两份独立单语字幕！');
        else toast.error(`拆分失败: ${res.error}`);
      }
    } catch (err: any) {
      toast.error(`处理异常: ${err.message || err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="flex flex-1 overflow-hidden p-6 gap-6">
        {/* 左侧：操作面板 */}
        <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card p-6 gap-5">
          <Tabs
            value={action}
            onValueChange={(v: any) => {
              setAction(v);
              setResult(null);
            }}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="merge" className="text-xs">
                两份单语字幕合并为双语
              </TabsTrigger>
              <TabsTrigger value="split" className="text-xs">
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
                  onClick={() => selectFile('primary')}
                  className="flex items-center justify-between rounded-lg border border-dashed border-border p-4 transition-colors hover:bg-muted/40 cursor-pointer"
                >
                  <div className="flex items-center gap-3 truncate">
                    <Languages className="h-5 w-5 text-primary shrink-0" />
                    <span className="text-xs truncate font-medium text-foreground">
                      {primaryPath ? primaryPath.split(/[/\\]/).pop() : '点击选择主字幕文件 (.srt / .vtt / .ass)'}
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
                  onClick={() => selectFile('secondary')}
                  className="flex items-center justify-between rounded-lg border border-dashed border-border p-4 transition-colors hover:bg-muted/40 cursor-pointer"
                >
                  <div className="flex items-center gap-3 truncate">
                    <Languages className="h-5 w-5 text-primary/70 shrink-0" />
                    <span className="text-xs truncate font-medium text-foreground">
                      {secondaryPath ? secondaryPath.split(/[/\\]/).pop() : '点击选择次字幕文件 (.srt / .vtt / .ass)'}
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
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="top">主语言在上方，次语言在下方 (推荐)</SelectItem>
                    <SelectItem value="bottom">次语言在上方，主语言在下方</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <Label className="text-xs text-foreground">
                双语字幕源文件
              </Label>
              <div
                onClick={() => selectFile('split')}
                className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 text-center transition-colors hover:bg-muted/40 cursor-pointer"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <UploadCloud className="h-6 w-6" />
                </div>
                <p className="mt-2 text-xs font-medium text-foreground">
                  {splitPath ? splitPath.split(/[/\\]/).pop() : '点击或拖拽包含两行文字的双语字幕文件'}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  自动将每条字幕中的两行文本拆解为 Part 1 与 Part 2 独立文件
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 右侧：保存控制 */}
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
                  disabled={isProcessing}
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
                  处理成功！
                </div>
                <div className="space-y-1">
                  {result.outputPaths.map((p, idx) => (
                    <div key={idx} className="flex items-center justify-between text-[11px]">
                      <span className="truncate max-w-[180px]">{p.split(/[/\\]/).pop()}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => window.ipc.invoke('toolbox:openFolder', p)}
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
              onClick={handleStart}
              disabled={
                (action === 'merge' && (!primaryPath || !secondaryPath)) ||
                (action === 'split' && !splitPath) ||
                isProcessing
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

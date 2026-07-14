/**
 * 输出行动条（NLE 版式底部横条）：输出方式分段控件 + 画质 + 路径 + 生成按钮。
 * 进度/成功/错误状态由预览区浮层呈现。
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { HelpHint } from '@/components/HelpHint';
import { Loader2, Play, FolderOpen, Flame, Layers } from 'lucide-react';
import type {
  MergeStatus,
  MergeOutputMode,
  VideoQuality,
} from '../../../types/subtitleMerge';

interface MergeButtonProps {
  outputPath: string | null;
  outputMode: MergeOutputMode;
  videoQuality: VideoQuality;
  status: MergeStatus;
  canMerge: boolean;
  /** 文件已就绪但未选输出路径：行动条内联提示 */
  needsOutputPath?: boolean;
  onSelectOutputPath: () => void;
  onOutputModeChange: (mode: MergeOutputMode) => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  onStartMerge: () => void;
}

export default function MergeButton({
  outputPath,
  outputMode,
  videoQuality,
  status,
  canMerge,
  needsOutputPath = false,
  onSelectOutputPath,
  onOutputModeChange,
  onVideoQualityChange,
  onStartMerge,
}: MergeButtonProps) {
  const { t } = useTranslation('subtitleMerge');
  const isProcessing = status === 'processing';
  // 画质仅对硬字幕烧录生效；软封装为流复制无损，无需该选项
  const isHardcode = outputMode === 'hardcode';
  const qualityOptions: Array<{ value: VideoQuality; label: string }> = [
    { value: 'original', label: t('videoQualityOriginal') },
    { value: 'high', label: t('videoQualityHigh') },
    { value: 'standard', label: t('videoQualityStandard') },
  ];

  const modeOptions: Array<{
    value: MergeOutputMode;
    icon: React.ReactNode;
    title: string;
    desc: string;
  }> = [
    {
      value: 'hardcode',
      icon: <Flame className="h-3.5 w-3.5" />,
      title: t('outputModeHardcode'),
      desc: t('outputModeHardcodeDesc'),
    },
    {
      value: 'softmux',
      icon: <Layers className="h-3.5 w-3.5" />,
      title: t('outputModeSoftmux'),
      desc: t('outputModeSoftmuxDesc'),
    },
  ];

  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* 输出方式：分段控件（说明入 tooltip） */}
        <div className="flex h-8 flex-none items-stretch gap-0.5 rounded-md bg-muted p-0.5">
          {modeOptions.map((option) => {
            const active = outputMode === option.value;
            return (
              <Tooltip key={option.value}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => onOutputModeChange(option.value)}
                    className={`flex items-center gap-1.5 rounded-[5px] px-2.5 text-xs transition-colors disabled:opacity-50 ${
                      active
                        ? 'bg-card font-semibold text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {option.icon}
                    {option.title}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{option.desc}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* 导出画质（仅烧录硬字幕生效） */}
        {isHardcode && (
          <div className="flex flex-none items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">
              {t('videoQuality')}
            </Label>
            <HelpHint text={t('videoQualityHint')} />
            <Select
              value={videoQuality}
              onValueChange={(v) => onVideoQualityChange(v as VideoQuality)}
              disabled={isProcessing}
            >
              <SelectTrigger className="w-[112px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {qualityOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* 输出路径：占据剩余宽度 */}
        <div className="flex min-w-[240px] flex-1 items-center gap-1.5">
          <Label className="flex-none text-xs text-muted-foreground">
            {t('outputPath')}
          </Label>
          <Input
            type="text"
            value={outputPath || ''}
            readOnly
            placeholder={t('selectOutputPath')}
            className={`min-w-0 flex-1 font-mono text-xs ${
              needsOutputPath ? 'border-warning/60' : ''
            }`}
            onClick={onSelectOutputPath}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={onSelectOutputPath}
            className="flex-none"
            aria-label={t('selectOutputPath')}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
        </div>

        {/* 合并按钮：行动条右端热区 */}
        <Button
          size="lg"
          className="min-w-[132px] flex-none"
          onClick={onStartMerge}
          disabled={!canMerge || isProcessing}
        >
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('processing')}
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              {t('generateVideo')}
            </>
          )}
        </Button>

        {needsOutputPath && (
          <p className="w-full text-[11.5px] text-warning">
            {t('outputPathRequiredHint')}
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}

/**
 * 合并按钮和进度显示组件
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Loader2,
  Play,
  FolderOpen,
  CheckCircle,
  XCircle,
  Folder,
  Flame,
  Layers,
} from 'lucide-react';
import type {
  MergeProgress,
  MergeStatus,
  MergeOutputMode,
} from '../../../types/subtitleMerge';

interface MergeButtonProps {
  videoPath: string | null;
  subtitlePath: string | null;
  outputPath: string | null;
  outputMode: MergeOutputMode;
  progress: MergeProgress;
  status: MergeStatus;
  canMerge: boolean;
  isCancelling?: boolean;
  onSelectOutputPath: () => void;
  onOutputModeChange: (mode: MergeOutputMode) => void;
  onStartMerge: () => void;
  onCancelMerge?: () => void;
  onOpenOutputFolder: () => void;
}

export default function MergeButton({
  videoPath,
  subtitlePath,
  outputPath,
  outputMode,
  progress,
  status,
  canMerge,
  isCancelling = false,
  onSelectOutputPath,
  onOutputModeChange,
  onStartMerge,
  onCancelMerge,
  onOpenOutputFolder,
}: MergeButtonProps) {
  const { t } = useTranslation('subtitleMerge');
  const isProcessing = status === 'processing';

  const modeOptions: Array<{
    value: MergeOutputMode;
    icon: React.ReactNode;
    title: string;
    desc: string;
  }> = [
    {
      value: 'hardcode',
      icon: <Flame className="w-3.5 h-3.5" />,
      title: t('outputModeHardcode') || '烧录硬字幕',
      desc:
        t('outputModeHardcodeDesc') || '字幕画入画面，兼容所有播放器（较慢）',
    },
    {
      value: 'softmux',
      icon: <Layers className="w-3.5 h-3.5" />,
      title: t('outputModeSoftmux') || '封装软字幕 (MKV)',
      desc:
        t('outputModeSoftmuxDesc') || '秒级完成、无损画质，播放器可开关字幕',
    },
  ];

  return (
    <div className="space-y-4">
      {/* 输出方式 */}
      <div className="space-y-2">
        <Label className="text-sm">{t('outputMode') || '输出方式'}</Label>
        <div className="grid grid-cols-2 gap-2">
          {modeOptions.map((option) => {
            const active = outputMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={isProcessing}
                onClick={() => onOutputModeChange(option.value)}
                className={`rounded-md border p-2 text-left transition-colors disabled:opacity-50 ${
                  active
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-accent/50'
                }`}
              >
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {option.icon}
                  {option.title}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {option.desc}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 输出路径 */}
      <div className="space-y-2">
        <Label className="text-sm">{t('outputPath') || '输出路径'}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={outputPath || ''}
            readOnly
            placeholder={t('selectOutputPath') || '选择输出路径'}
            className="flex-1 text-sm"
          />
          <Button variant="outline" size="icon" onClick={onSelectOutputPath}>
            <FolderOpen className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* 进度条 */}
      {status === 'processing' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {t('processing') || '处理中...'}
            </span>
            <div className="flex items-center gap-2">
              <span className="font-medium">
                {Math.round(progress.percent)}%
              </span>
              {onCancelMerge && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={onCancelMerge}
                  disabled={isCancelling}
                >
                  <XCircle className="w-3 h-3 mr-1" />
                  {isCancelling
                    ? t('cancelling') || '取消中...'
                    : t('cancel') || '取消'}
                </Button>
              )}
            </div>
          </div>
          <Progress value={progress.percent} className="h-2" />
          {progress.timeMark && (
            <p className="text-xs text-muted-foreground">
              {t('currentTime') || '当前时间'}: {progress.timeMark}
            </p>
          )}
        </div>
      )}

      {/* 完成状态 */}
      {status === 'completed' && (
        <div className="flex items-center gap-2 p-3 bg-success/10 rounded-lg">
          <CheckCircle className="w-5 h-5 text-success" />
          <span className="text-sm text-success flex-1">
            {t('mergeSuccess') || '合并成功'}
          </span>
          <Button variant="outline" size="sm" onClick={onOpenOutputFolder}>
            <Folder className="w-4 h-4 mr-1" />
            {t('openFolder') || '打开文件夹'}
          </Button>
        </div>
      )}

      {/* 错误状态 */}
      {status === 'error' && progress.errorMessage && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-lg">
          <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-destructive">
              {t('mergeError') || '合并失败'}
            </p>
            <p className="text-xs text-destructive/70 mt-1 break-all">
              {progress.errorMessage}
            </p>
          </div>
        </div>
      )}

      {/* 合并按钮 */}
      <Button
        className="w-full"
        size="lg"
        onClick={onStartMerge}
        disabled={!canMerge || status === 'processing'}
      >
        {status === 'processing' ? (
          <>
            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
            {t('processing') || '处理中...'}
          </>
        ) : (
          <>
            <Play className="w-5 h-5 mr-2" />
            {t('generateVideo') || '生成视频'}
          </>
        )}
      </Button>

      {/* 提示信息：按缺失项动态生成 */}
      {!canMerge && status !== 'processing' && (
        <p className="text-xs text-muted-foreground text-center">
          {!videoPath && !subtitlePath
            ? t('selectFilesToMerge') || '请先选择视频和字幕文件'
            : !videoPath
              ? t('selectVideoToMerge') || '请选择视频文件'
              : !subtitlePath
                ? t('selectSubtitleToMerge') || '请选择字幕文件'
                : t('selectOutputPathToMerge') || '请选择输出路径'}
        </p>
      )}
    </div>
  );
}

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
      title: t('outputModeHardcode'),
      desc: t('outputModeHardcodeDesc'),
    },
    {
      value: 'softmux',
      icon: <Layers className="w-3.5 h-3.5" />,
      title: t('outputModeSoftmux'),
      desc: t('outputModeSoftmuxDesc'),
    },
  ];

  return (
    <div className="space-y-4">
      {/* 输出方式 */}
      <div className="space-y-2">
        <Label className="text-sm">{t('outputMode')}</Label>
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
        <Label className="text-sm">{t('outputPath')}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={outputPath || ''}
            readOnly
            placeholder={t('selectOutputPath')}
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
            <span className="text-muted-foreground">{t('processing')}</span>
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
                  {isCancelling ? t('cancelling') : t('cancel')}
                </Button>
              )}
            </div>
          </div>
          <Progress value={progress.percent} className="h-2" />
          {progress.timeMark && (
            <p className="text-xs text-muted-foreground">
              {t('currentTime')}: {progress.timeMark}
            </p>
          )}
        </div>
      )}

      {/* 完成状态 */}
      {status === 'completed' && (
        <div className="flex items-center gap-2 p-3 bg-success/10 rounded-lg">
          <CheckCircle className="w-5 h-5 text-success" />
          <span className="text-sm text-success flex-1">
            {t('mergeSuccess')}
          </span>
          <Button variant="outline" size="sm" onClick={onOpenOutputFolder}>
            <Folder className="w-4 h-4 mr-1" />
            {t('openFolder')}
          </Button>
        </div>
      )}

      {/* 错误状态 */}
      {status === 'error' && progress.errorMessage && (
        <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-lg">
          <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-destructive">{t('mergeError')}</p>
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
            {t('processing')}
          </>
        ) : (
          <>
            <Play className="w-5 h-5 mr-2" />
            {t('generateVideo')}
          </>
        )}
      </Button>

      {/* 提示信息：按缺失项动态生成 */}
      {!canMerge && status !== 'processing' && (
        <p className="text-xs text-muted-foreground text-center">
          {!videoPath && !subtitlePath
            ? t('selectFilesToMerge')
            : !videoPath
              ? t('selectVideoToMerge')
              : !subtitlePath
                ? t('selectSubtitleToMerge')
                : t('selectOutputPathToMerge')}
        </p>
      )}
    </div>
  );
}

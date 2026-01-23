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
} from 'lucide-react';
import type { MergeProgress, MergeStatus } from '../../../types/subtitleMerge';

interface MergeButtonProps {
  outputPath: string | null;
  progress: MergeProgress;
  status: MergeStatus;
  canMerge: boolean;
  onSelectOutputPath: () => void;
  onStartMerge: () => void;
  onOpenOutputFolder: () => void;
}

export default function MergeButton({
  outputPath,
  progress,
  status,
  canMerge,
  onSelectOutputPath,
  onStartMerge,
  onOpenOutputFolder,
}: MergeButtonProps) {
  const { t } = useTranslation('subtitleMerge');

  return (
    <div className="space-y-4">
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
            <span className="font-medium">{Math.round(progress.percent)}%</span>
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
        <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/30 rounded-lg">
          <CheckCircle className="w-5 h-5 text-green-600" />
          <span className="text-sm text-green-700 dark:text-green-400 flex-1">
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
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 rounded-lg">
          <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-red-700 dark:text-red-400">
              {t('mergeError') || '合并失败'}
            </p>
            <p className="text-xs text-red-600/70 dark:text-red-400/70 mt-1 break-all">
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

      {/* 提示信息 */}
      {!canMerge && status !== 'processing' && (
        <p className="text-xs text-muted-foreground text-center">
          {t('selectFilesToMerge') || '请先选择视频和字幕文件'}
        </p>
      )}
    </div>
  );
}

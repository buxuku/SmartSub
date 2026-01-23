/**
 * 字幕合并主面板组件
 * 整合所有子组件，提供完整的字幕合并功能界面
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import FileSelector from './FileSelector';
import StylePresets from './StylePresets';
import BasicStyleSettings from './BasicStyleSettings';
import AdvancedStyleSettings from './AdvancedStyleSettings';
import VideoPreview from './VideoPreview';
import MergeButton from './MergeButton';
import {
  useSubtitleMerge,
  type UseSubtitleMergeOptions,
} from './hooks/useSubtitleMerge';

interface SubtitleMergePanelProps extends UseSubtitleMergeOptions {
  /** 面板标题 */
  title?: string;
  /** 是否显示标题 */
  showTitle?: boolean;
  /** 自定义类名 */
  className?: string;
}

/**
 * 字幕合并主面板
 * 可独立使用，也可嵌入到其他页面中
 */
export default function SubtitleMergePanel({
  title,
  showTitle = true,
  className = '',
  ...hookOptions
}: SubtitleMergePanelProps) {
  const { t } = useTranslation('subtitleMerge');

  const {
    // 文件状态
    videoPath,
    subtitlePath,
    videoInfo,
    subtitleInfo,

    // 样式状态
    style,
    activePresetId,

    // 输出状态
    outputPath,

    // 进度状态
    progress,
    status,

    // 文件操作方法
    selectVideo,
    selectSubtitle,
    clearFiles,

    // 样式操作方法
    updateStyle,
    applyPreset,

    // 输出操作方法
    selectOutputPath,

    // 合并操作方法
    startMerge,
    canMerge,

    // 其他方法
    openOutputFolder,
  } = useSubtitleMerge(hookOptions);

  const isProcessing = status === 'processing';

  return (
    <div className={`h-full flex flex-col ${className}`}>
      {/* 文件选择区域 - 紧凑型 */}
      <div className="flex-shrink-0 mb-3">
        <FileSelector
          videoPath={videoPath}
          subtitlePath={subtitlePath}
          videoInfo={videoInfo}
          subtitleInfo={subtitleInfo}
          onSelectVideo={selectVideo}
          onSelectSubtitle={selectSubtitle}
          onClearVideo={() => clearFiles()}
          onClearSubtitle={() => clearFiles()}
          disabled={isProcessing}
        />
      </div>

      {/* 主内容区域 - 左右分栏 */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* 左侧：样式设置 */}
        <Card className="flex flex-col min-h-0 overflow-hidden">
          <CardHeader className="flex-shrink-0 py-3 px-4">
            <CardTitle className="text-sm">
              {t('styleSettings') || '字幕样式设置'}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 pt-0 px-4 pb-4">
            <ScrollArea className="h-full">
              <div className="space-y-3 pr-3">
                {/* 预设样式 */}
                <StylePresets
                  activePresetId={activePresetId}
                  onSelectPreset={applyPreset}
                  disabled={isProcessing}
                />

                <Separator />

                {/* 基础设置 */}
                <div>
                  <h3 className="text-xs font-medium mb-2 text-muted-foreground">
                    {t('basicSettings') || '基础设置'}
                  </h3>
                  <BasicStyleSettings
                    style={style}
                    onUpdateStyle={updateStyle}
                    disabled={isProcessing}
                  />
                </div>

                <Separator />

                {/* 高级设置 */}
                <AdvancedStyleSettings
                  style={style}
                  onUpdateStyle={updateStyle}
                  disabled={isProcessing}
                />
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* 右侧：预览和导出 */}
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden">
          {/* 预览区域 */}
          <Card className="flex flex-col min-h-0 overflow-hidden">
            <CardHeader className="flex-shrink-0 py-3 px-4">
              <CardTitle className="text-sm">
                {t('preview') || '效果预览'}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 pt-0 px-4 pb-4 overflow-auto">
              <VideoPreview
                videoPath={videoPath}
                videoInfo={videoInfo}
                style={style}
              />
            </CardContent>
          </Card>

          {/* 导出区域 */}
          <Card className="flex-shrink-0">
            <CardContent className="p-4">
              <MergeButton
                outputPath={outputPath}
                progress={progress}
                status={status}
                canMerge={canMerge}
                onSelectOutputPath={selectOutputPath}
                onStartMerge={startMerge}
                onOpenOutputFolder={openOutputFolder}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

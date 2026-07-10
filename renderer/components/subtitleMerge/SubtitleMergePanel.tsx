/**
 * 字幕合并主面板组件
 * 左栏：文件 + 样式 + 输出控件（滚动）；右栏：预览独占并最大化，处理状态以浮层呈现
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import FileSelector from './FileSelector';
import StylePresets from './StylePresets';
import BasicStyleSettings from './BasicStyleSettings';
import EffectStyleSettings from './EffectStyleSettings';
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
    outputMode,
    videoQuality,

    // 进度状态
    progress,
    status,

    // 文件操作方法
    selectVideo,
    selectSubtitle,
    clearVideo,
    clearSubtitle,

    // 样式操作方法
    updateStyle,
    applyPreset,

    // 输出操作方法
    selectOutputPath,
    setOutputMode,
    setVideoQuality,

    // 合并操作方法
    startMerge,
    cancelMerge,
    isCancelling,
    canMerge,

    // 其他方法
    openOutputFolder,
  } = useSubtitleMerge(hookOptions);

  const isProcessing = status === 'processing';
  // 软字幕样式由播放器决定，样式设置仅对烧录生效
  const isSoftMux = outputMode === 'softmux';
  const styleDisabled = isProcessing || isSoftMux;

  return (
    <div className={`h-full flex flex-col ${className}`}>
      {videoPath && subtitlePath && !outputPath && status !== 'processing' && (
        <div className="flex-shrink-0 mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-muted-foreground">
          {t('outputPathRequiredHint')}
        </div>
      )}
      {/* 文件选择区域 - 紧凑型，置顶全宽 */}
      <div className="flex-shrink-0 mb-3">
        <FileSelector
          videoPath={videoPath}
          subtitlePath={subtitlePath}
          videoInfo={videoInfo}
          subtitleInfo={subtitleInfo}
          onSelectVideo={selectVideo}
          onSelectSubtitle={selectSubtitle}
          onClearVideo={clearVideo}
          onClearSubtitle={clearSubtitle}
          disabled={isProcessing}
        />
      </div>

      {/* 主内容区域 - 左：设置+输出（窄栏滚动）；右：预览独占（最大化） */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(340px,400px)_1fr] gap-3">
        {/* 左侧：样式设置 + 输出控件 */}
        <Card className="flex flex-col min-h-0 overflow-hidden">
          <CardContent className="flex-1 min-h-0 p-0">
            <ScrollArea className="h-full">
              <div className="space-y-3 p-4">
                {/* 软字幕模式提示：样式仅对烧录生效 */}
                {isSoftMux && (
                  <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
                    {t('styleOnlyForHardcode')}
                  </p>
                )}

                {/* 预设样式 */}
                <StylePresets
                  activePresetId={activePresetId}
                  onSelectPreset={applyPreset}
                  disabled={styleDisabled}
                />

                <Separator />

                {/* 基础设置 */}
                <div>
                  <h3 className="label-caps mb-2">{t('basicSettings')}</h3>
                  <BasicStyleSettings
                    style={style}
                    onUpdateStyle={updateStyle}
                    disabled={styleDisabled}
                  />
                </div>

                <Separator />

                {/* 样式效果：描边/背景框模式二选一 + 按模式显示生效参数 */}
                <div>
                  <h3 className="label-caps mb-2">{t('effectSettings')}</h3>
                  <EffectStyleSettings
                    style={style}
                    onUpdateStyle={updateStyle}
                    disabled={styleDisabled}
                  />
                </div>

                <Separator />

                {/* 高级设置 */}
                <AdvancedStyleSettings
                  style={style}
                  onUpdateStyle={updateStyle}
                  disabled={styleDisabled}
                />
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* 右侧：上=预览（最大化），下=输出控件，填满预览之外的竖向空间 */}
        <div className="flex flex-col min-h-0 gap-3">
          <Card className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <CardContent className="flex-1 min-h-0 p-3 overflow-hidden">
              <VideoPreview
                videoPath={videoPath}
                videoInfo={videoInfo}
                style={style}
                subtitlePath={subtitlePath}
                progress={progress}
                status={status}
                isCancelling={isCancelling}
                onCancelMerge={cancelMerge}
                onOpenOutputFolder={openOutputFolder}
              />
            </CardContent>
          </Card>

          {/* 输出方式 + 画质 + 路径 + 生成 */}
          <Card className="flex-shrink-0">
            <CardContent className="p-4">
              <MergeButton
                outputPath={outputPath}
                outputMode={outputMode}
                videoQuality={videoQuality}
                status={status}
                canMerge={canMerge}
                onSelectOutputPath={selectOutputPath}
                onOutputModeChange={setOutputMode}
                onVideoQualityChange={setVideoQuality}
                onStartMerge={startMerge}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

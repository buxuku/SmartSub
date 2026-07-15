/**
 * 字幕合并主面板组件 — NLE 三区版式：
 * 左 inspector（样式设置滚动栏）｜右舞台（文件条 + 预览 + 迷你时间轴）｜底部输出行动条
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Paintbrush, Play, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import StepGuide from '@/components/StepGuide';
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
    audioTrackPath,
    audioTrackMode,

    // 样式状态
    style,
    activePresetId,
    userPresets,

    // 输出状态
    outputPath,
    outputMode,
    videoQuality,
    encoderMode,
    hwAccelInfo,
    hwFallbackOccurred,

    // 进度状态
    progress,
    status,

    // 文件操作方法
    selectVideo,
    selectSubtitle,
    selectAudioTrack,
    setAudioTrackMode,
    clearVideo,
    clearSubtitle,
    clearAudioTrack,

    // 样式操作方法
    updateStyle,
    applyPreset,
    saveStylePreset,
    deleteStylePreset,

    // 输出操作方法
    selectOutputPath,
    setOutputMode,
    setVideoQuality,
    setEncoderMode,

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
    <div
      className={`grid h-full min-h-0 grid-cols-1 gap-2.5 lg:grid-cols-[332px_minmax(0,1fr)] ${className}`}
    >
      {/* 左 inspector：字幕样式（分区滚动） */}
      <Panel className="min-h-0 overflow-hidden">
        <PanelHeader
          title={t('styleInspector')}
          meta={isSoftMux ? t('styleOnlyForHardcode') : undefined}
        />
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-3">
            {/* 预设样式（系统预设 + 我的样式） */}
            <StylePresets
              activePresetId={activePresetId}
              onSelectPreset={applyPreset}
              disabled={styleDisabled}
              userPresets={userPresets}
              onSaveStylePreset={saveStylePreset}
              onDeleteStylePreset={deleteStylePreset}
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
      </Panel>

      {/* 右舞台 + 底部输出行动条 */}
      <div className="flex min-h-0 flex-col gap-2.5">
        <Panel className="min-h-0 flex-1 overflow-hidden">
          {/* 文件条：视频槽 + 字幕槽（30px 紧凑槽位） */}
          <div className="flex flex-none items-center gap-2 border-b border-border p-2">
            <FileSelector
              videoPath={videoPath}
              subtitlePath={subtitlePath}
              videoInfo={videoInfo}
              subtitleInfo={subtitleInfo}
              audioTrackPath={audioTrackPath}
              onSelectVideo={selectVideo}
              onSelectSubtitle={selectSubtitle}
              onSelectAudioTrack={selectAudioTrack}
              onClearVideo={clearVideo}
              onClearSubtitle={clearSubtitle}
              onClearAudioTrack={clearAudioTrack}
              disabled={isProcessing}
            />
          </div>
          {/* 舞台：预览 + 走带（原生控制条）+ 迷你时间轴；未选视频时为统一三步引导 */}
          <div className="min-h-0 flex-1 overflow-hidden p-2.5">
            {videoPath ? (
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
            ) : (
              <StepGuide
                steps={[
                  {
                    icon: Video,
                    title: t('emptyGuide.step1'),
                    desc: t('emptyGuide.step1Desc'),
                  },
                  {
                    icon: Paintbrush,
                    title: t('emptyGuide.step2'),
                    desc: t('emptyGuide.step2Desc'),
                  },
                  {
                    icon: Play,
                    title: t('emptyGuide.step3'),
                    desc: t('emptyGuide.step3Desc'),
                  },
                ]}
                actions={
                  <Button onClick={selectVideo} disabled={isProcessing}>
                    <Video className="h-4 w-4" />
                    {t('clickToSelectVideo')}
                  </Button>
                }
              />
            )}
          </div>
        </Panel>

        {/* 输出行动条：方式 + 画质 + 路径 + 生成（主行动固定右下热区） */}
        <Panel className="flex-none">
          <div className="p-2.5">
            <MergeButton
              outputPath={outputPath}
              outputMode={outputMode}
              videoQuality={videoQuality}
              encoderMode={encoderMode}
              hwAccelInfo={hwAccelInfo}
              hwFallbackOccurred={hwFallbackOccurred}
              hasAudioTrack={Boolean(audioTrackPath)}
              audioTrackMode={audioTrackMode}
              queuedAhead={progress.queuedAhead || 0}
              status={status}
              canMerge={canMerge}
              needsOutputPath={Boolean(
                videoPath && subtitlePath && !outputPath && !isProcessing,
              )}
              onSelectOutputPath={selectOutputPath}
              onOutputModeChange={setOutputMode}
              onVideoQualityChange={setVideoQuality}
              onEncoderModeChange={setEncoderMode}
              onAudioTrackModeChange={setAudioTrackMode}
              onStartMerge={startMerge}
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}

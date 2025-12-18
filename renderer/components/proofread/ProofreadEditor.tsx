import React, { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Check, Save, Loader2 } from 'lucide-react';

// 复用原有的子组件和 hooks
import { useStandaloneSubtitles } from '../../hooks/useStandaloneSubtitles';
import { useVideoPlayer } from '../../hooks/useVideoPlayer';
import VideoPlayer from '../subtitle/VideoPlayer';
import CurrentSubtitle from '../subtitle/CurrentSubtitle';
import VideoInfo from '../subtitle/VideoInfo';
import SubtitleList from '../subtitle/SubtitleList';
import SubtitleEditToolbar from '../subtitle/SubtitleEditToolbar';

interface PendingFile {
  id: string;
  videoPath?: string;
  fileName: string;
  selectedSource?: string;
  selectedTarget?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  status: 'pending' | 'proofreading' | 'completed';
}

interface ProofreadEditorProps {
  file: PendingFile;
  onMarkComplete: () => void;
  onBack: () => void;
}

export default function ProofreadEditor({
  file,
  onMarkComplete,
  onBack,
}: ProofreadEditorProps) {
  const { t } = useTranslation('home');

  // 构建配置
  const config = useMemo(
    () => ({
      videoPath: file.videoPath,
      sourceSubtitlePath: file.selectedSource,
      targetSubtitlePath: file.selectedTarget,
      sourceLanguage: file.sourceLanguage,
      targetLanguage: file.targetLanguage,
    }),
    [file],
  );

  // 使用独立的字幕 hook
  const {
    mergedSubtitles,
    updateSubtitles,
    videoPath,
    currentSubtitleIndex,
    setCurrentSubtitleIndex,
    videoInfo,
    hasTranslationFile,
    shouldShowTranslation,
    subtitleTracksForPlayer,
    isLoading,
    handleSubtitleChange,
    handleSave,
    getSubtitleStats,
    isTranslationFailed,
    getFailedTranslationIndices,
    goToNextFailedTranslation,
    goToPreviousFailedTranslation,
    // 编辑增强
    handleUndo,
    handleRedo,
    canUndo,
    canRedo,
    handleMergeSubtitles,
    handleSplitSubtitle,
    // 光标位置
    handleCursorPositionChange,
    getCursorPosition,
  } = useStandaloneSubtitles(config, true);

  // 使用视频播放器 hook
  const {
    currentTime,
    duration,
    setDuration,
    isPlaying,
    playbackRate,
    playerRef,
    handleProgress,
    togglePlay,
    handleSubtitleClick,
    goToNextSubtitle,
    goToPreviousSubtitle,
    seekVideo,
    changePlaybackRate,
    setPlaybackRate,
  } = useVideoPlayer(
    mergedSubtitles,
    currentSubtitleIndex,
    setCurrentSubtitleIndex,
  );

  // 是否有视频
  const hasVideo = !!videoPath;

  // 外部触发器状态
  const [triggerAiOptimize, setTriggerAiOptimize] = useState(false);
  const [triggerSplit, setTriggerSplit] = useState(false);

  // 处理从字幕列表点击 AI 优化按钮
  const handleAiOptimizeClick = useCallback(
    (index: number) => {
      handleSubtitleClick(index);
      // 使用 setTimeout 确保 currentSubtitleIndex 已更新
      setTimeout(() => {
        setTriggerAiOptimize(true);
      }, 0);
    },
    [handleSubtitleClick],
  );

  // 处理从字幕列表点击拆分按钮
  const handleSplitClick = useCallback(
    (index: number) => {
      handleSubtitleClick(index);
      // 使用 setTimeout 确保 currentSubtitleIndex 已更新
      setTimeout(() => {
        setTriggerSplit(true);
      }, 0);
    },
    [handleSubtitleClick],
  );

  // 重置触发器
  const handleTriggerHandled = useCallback(() => {
    setTriggerAiOptimize(false);
    setTriggerSplit(false);
  }, []);

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-background flex-shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            {t('backToList') || '返回列表'}
          </Button>
          <div className="text-sm text-muted-foreground">{file.fileName}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSave}>
            <Save className="w-4 h-4 mr-1" />
            {t('save') || '保存'}
          </Button>
          <Button variant="default" size="sm" onClick={onMarkComplete}>
            <Check className="w-4 h-4 mr-1" />
            {t('markCompleteAndBack') || '标记完成'}
          </Button>
        </div>
      </div>

      {/* 编辑工具栏 */}
      <SubtitleEditToolbar
        subtitles={mergedSubtitles}
        onSubtitlesChange={updateSubtitles}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        currentSubtitleIndex={currentSubtitleIndex}
        onMergeSubtitles={handleMergeSubtitles}
        onSplitSubtitle={handleSplitSubtitle}
        shouldShowTranslation={shouldShowTranslation}
        getCursorPosition={getCursorPosition}
        triggerAiOptimize={triggerAiOptimize}
        triggerSplit={triggerSplit}
        onTriggerHandled={handleTriggerHandled}
      />

      {/* 主内容区 - 复用原有布局 */}
      <div
        className={`grid gap-2 flex-1 overflow-auto min-h-0 p-4 ${
          hasVideo ? 'grid-cols-2' : 'grid-cols-1'
        }`}
      >
        {/* 左侧：视频播放器和控制区域 */}
        {hasVideo && (
          <div className="flex flex-col overflow-auto min-h-0">
            {/* 视频播放器组件 */}
            <VideoPlayer
              videoPath={videoPath}
              playerRef={playerRef}
              isPlaying={isPlaying}
              playbackRate={playbackRate}
              togglePlay={togglePlay}
              goToNextSubtitle={goToNextSubtitle}
              goToPreviousSubtitle={goToPreviousSubtitle}
              seekVideo={seekVideo}
              handleProgress={handleProgress}
              setDuration={setDuration}
              changePlaybackRate={changePlaybackRate}
              setPlaybackRate={setPlaybackRate}
              subtitleTracks={subtitleTracksForPlayer}
            />

            {/* 当前字幕预览组件 */}
            <CurrentSubtitle
              currentSubtitleIndex={currentSubtitleIndex}
              currentTime={currentTime}
              duration={duration}
              mergedSubtitles={mergedSubtitles}
              shouldShowTranslation={shouldShowTranslation}
              hasTranslationFile={hasTranslationFile}
            />

            {/* 视频信息和字幕统计组件 */}
            <VideoInfo
              fileName={videoInfo.fileName}
              extension={videoInfo.extension}
              duration={duration}
              subtitleStats={getSubtitleStats()}
              shouldShowTranslation={shouldShowTranslation}
            />
          </div>
        )}

        {/* 右侧/全屏：字幕列表组件 */}
        <SubtitleList
          mergedSubtitles={mergedSubtitles}
          currentSubtitleIndex={currentSubtitleIndex}
          shouldShowTranslation={shouldShowTranslation}
          handleSubtitleClick={handleSubtitleClick}
          handleSubtitleChange={handleSubtitleChange}
          isTranslationFailed={isTranslationFailed}
          getFailedTranslationIndices={getFailedTranslationIndices}
          goToNextFailedTranslation={goToNextFailedTranslation}
          goToPreviousFailedTranslation={goToPreviousFailedTranslation}
          onCursorPositionChange={handleCursorPositionChange}
          onAiOptimizeClick={handleAiOptimizeClick}
          onSplitClick={handleSplitClick}
        />
      </div>
    </div>
  );
}

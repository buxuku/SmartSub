import React, { useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ArrowLeft, Check, Save, Loader2 } from 'lucide-react';

// 复用原有的子组件和 hooks
import { useStandaloneSubtitles } from '../../hooks/useStandaloneSubtitles';
import { useRetranslateFailed } from '../../hooks/useRetranslateFailed';
import { useVideoPlayer } from '../../hooks/useVideoPlayer';
import { useHotkeys, isMacPlatform } from '../../hooks/useHotkeys';
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
  finalTargetPath?: string; // 目标翻译文件路径（用户配置格式）
  translateContent?: string; // 翻译内容格式设置
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
  const { t: commonT } = useTranslation('common');

  // 构建配置
  const config = useMemo(
    () => ({
      videoPath: file.videoPath,
      sourceSubtitlePath: file.selectedSource,
      targetSubtitlePath: file.selectedTarget,
      sourceLanguage: file.sourceLanguage,
      targetLanguage: file.targetLanguage,
      finalTargetSubtitlePath: file.finalTargetPath,
      translateContent: file.translateContent,
    }),
    [file],
  );

  // 使用独立的字幕 hook
  const {
    mergedSubtitles,
    updateSubtitles,
    getSubtitles,
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
    isDirty,
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
    handleTimeChange,
    // 光标位置
    handleCursorPositionChange,
    getCursorPosition,
  } = useStandaloneSubtitles(config, true);

  // 失败字幕批量重翻（复用任务翻译链路）
  const retranslate = useRetranslateFailed({
    getSubtitles,
    getFailedTranslationIndices,
    updateSubtitles,
    sourceLanguage: file.sourceLanguage,
    targetLanguage: file.targetLanguage,
  });

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

  // 未保存修改守卫
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);

  // 返回列表：有未保存修改时先拦截
  const handleBackClick = useCallback(() => {
    if (isDirty) {
      setShowUnsavedDialog(true);
      return;
    }
    onBack();
  }, [isDirty, onBack]);

  const handleSaveAndBack = useCallback(async () => {
    const ok = await handleSave();
    setShowUnsavedDialog(false);
    if (ok) onBack();
  }, [handleSave, onBack]);

  const handleDiscardAndBack = useCallback(() => {
    setShowUnsavedDialog(false);
    onBack();
  }, [onBack]);

  // 标记完成隐含保存：保证完成态文件与界面一致；保存失败则留在编辑器
  const handleMarkCompleteClick = useCallback(async () => {
    const ok = await handleSave();
    if (ok) onMarkComplete();
  }, [handleSave, onMarkComplete]);

  // Cmd/Ctrl+F：递增 token 通知工具栏展开搜索替换
  const [searchOpenToken, setSearchOpenToken] = useState(0);

  // 编辑器快捷键（4.3 清单）
  useHotkeys([
    { combo: 'mod+s', allowInInput: true, handler: () => void handleSave() },
    {
      combo: 'mod+z',
      allowInInput: true,
      handler: () => {
        if (canUndo) handleUndo();
      },
    },
    {
      combo: 'shift+mod+z',
      allowInInput: true,
      handler: () => {
        if (canRedo) handleRedo();
      },
    },
    {
      combo: 'mod+f',
      allowInInput: true,
      handler: () => setSearchOpenToken((n) => n + 1),
    },
    {
      combo: 'space',
      handler: () => {
        if (hasVideo) togglePlay();
      },
    },
    { combo: 'arrowup', handler: () => goToPreviousSubtitle() },
    { combo: 'arrowdown', handler: () => goToNextSubtitle() },
    {
      combo: 'escape',
      allowInInput: true,
      preventDefault: false,
      handler: (e) => {
        const el = e.target as HTMLElement | null;
        if (el && typeof el.blur === 'function') el.blur();
      },
    },
  ]);

  const modLabel = isMacPlatform() ? '⌘' : 'Ctrl';

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
          <Button variant="ghost" size="sm" onClick={handleBackClick}>
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
          <Button variant="default" size="sm" onClick={handleMarkCompleteClick}>
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
        searchOpenToken={searchOpenToken}
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
          onTimeChange={handleTimeChange}
          retranslate={retranslate}
          onMergeRange={handleMergeSubtitles}
        />
      </div>

      {/* 底部快捷键提示条 */}
      <div className="flex-shrink-0 flex items-center justify-center gap-3 border-t bg-muted/30 px-4 py-1 text-[11px] text-muted-foreground select-none">
        {hasVideo && (
          <span>
            <kbd className="rounded border bg-background px-1">Space</kbd>{' '}
            {commonT('shortcuts.playPause')}
          </span>
        )}
        <span>
          <kbd className="rounded border bg-background px-1">↑↓</kbd>{' '}
          {commonT('shortcuts.prevNextSubtitle')}
        </span>
        <span>
          <kbd className="rounded border bg-background px-1">Tab</kbd>{' '}
          {commonT('shortcuts.switchSourceTarget')}
        </span>
        <span>
          <kbd className="rounded border bg-background px-1">{modLabel}S</kbd>{' '}
          {commonT('shortcuts.save')}
        </span>
        <span>
          <kbd className="rounded border bg-background px-1">?</kbd>{' '}
          {commonT('shortcuts.hintMore')}
        </span>
      </div>

      {/* 未保存修改确认对话框 */}
      <AlertDialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('unsavedChangesTitle') || '有未保存的修改'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('unsavedChangesDesc') ||
                '当前字幕有未保存的修改，直接返回将丢失这些修改。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('keepEditing') || '继续编辑'}
            </AlertDialogCancel>
            <Button variant="outline" onClick={handleDiscardAndBack}>
              {t('discardAndBack') || '不保存返回'}
            </Button>
            <AlertDialogAction onClick={handleSaveAndBack}>
              {t('saveAndBack') || '保存并返回'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

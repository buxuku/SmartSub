import React, { useMemo, useState, useCallback, useEffect } from 'react';
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
import { ArrowLeft, Check, Loader2, Save, Undo2 } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// 复用原有的子组件和 hooks
import { useStandaloneSubtitles } from '../../hooks/useStandaloneSubtitles';
import { useRetranslateFailed } from '../../hooks/useRetranslateFailed';
import { useVideoPlayer } from '../../hooks/useVideoPlayer';
import { useHotkeys, isMacPlatform } from '../../hooks/useHotkeys';
import VideoPlayer from '../subtitle/VideoPlayer';
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
  proofreadDataFile?: string;
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
      proofreadDataFile: file.proofreadDataFile,
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
    handleDeleteSubtitle,
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

  // 视图偏好（从 SubtitleList 上提，由编辑工具栏统一控制）：
  // 折叠左侧面板 / 展开全部 / 字号
  const [videoCollapsed, setVideoCollapsed] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [fontScale, setFontScale] = useState<'s' | 'm' | 'l'>('m');

  // 读取持久化偏好（仅客户端，避免 SSR 不一致）
  useEffect(() => {
    try {
      setVideoCollapsed(
        localStorage.getItem('proofread:videoCollapsed') === '1',
      );
      setExpandAll(localStorage.getItem('proofread:expandAll') === '1');
      const fs = localStorage.getItem('proofread:fontScale');
      if (fs === 's' || fs === 'm' || fs === 'l') setFontScale(fs);
    } catch {
      // localStorage 不可用时用默认值
    }
  }, []);

  const toggleVideoCollapsed = useCallback(() => {
    setVideoCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('proofread:videoCollapsed', next ? '1' : '0');
      } catch {
        // 忽略持久化失败
      }
      return next;
    });
  }, []);

  const toggleExpandAll = useCallback(() => {
    setExpandAll((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('proofread:expandAll', next ? '1' : '0');
      } catch {
        // 忽略持久化失败
      }
      return next;
    });
  }, []);

  const handleFontScale = useCallback((scale: 's' | 'm' | 'l') => {
    setFontScale(scale);
    try {
      localStorage.setItem('proofread:fontScale', scale);
    } catch {
      // 忽略持久化失败
    }
  }, []);

  // 左侧面板是否展示（无视频或手动折叠时隐藏，字幕列表占满宽度）
  const showLeftPanel = hasVideo && !videoCollapsed;

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

  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

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
      <div className="sticky top-0 z-10 flex-shrink-0 bg-background border-b">
        {/* 顶部工具栏 */}
        <TooltipProvider>
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 flex-shrink-0"
                    aria-label={t('backToList')}
                    onClick={handleBackClick}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t('backToList')}</TooltipContent>
              </Tooltip>
              <div className="truncate text-sm text-muted-foreground">
                {file.fileName}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleSave}
                  >
                    <Save className="h-4 w-4" />
                    {t('saveSubtitles')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[280px]">
                  <p>{t('saveSubtitlesTip')}</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleMarkCompleteClick}
                  >
                    <Check className="h-4 w-4" />
                    {t('markCompleteAndBack')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[280px]">
                  <p>{t('completeAndReturnTip')}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </TooltipProvider>

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
          onLocateSubtitle={handleSubtitleClick}
          hasVideo={hasVideo}
          videoCollapsed={videoCollapsed}
          onToggleVideoCollapsed={toggleVideoCollapsed}
          expandAll={expandAll}
          onToggleExpandAll={toggleExpandAll}
          fontScale={fontScale}
          onFontScale={handleFontScale}
        />
      </div>

      {/* 主内容区 - 复用原有布局 */}
      <div
        className={`grid gap-2 flex-1 overflow-auto min-h-0 p-4 ${
          showLeftPanel ? 'grid-cols-2' : 'grid-cols-1'
        }`}
      >
        {/* 左侧：视频播放器和控制区域 */}
        {showLeftPanel && (
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
          onDeleteClick={handleDeleteSubtitle}
          onTimeChange={handleTimeChange}
          retranslate={retranslate}
          onMergeRange={handleMergeSubtitles}
          expandAll={expandAll}
          fontScale={fontScale}
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
            <AlertDialogTitle>{t('unsavedChangesTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('unsavedChangesDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('keepEditing')}</AlertDialogCancel>
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={handleDiscardAndBack}
            >
              <Undo2 className="h-4 w-4" />
              {t('discardAndBack')}
            </Button>
            <AlertDialogAction className="gap-1.5" onClick={handleSaveAndBack}>
              <Save className="h-4 w-4" />
              {t('saveAndBack')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

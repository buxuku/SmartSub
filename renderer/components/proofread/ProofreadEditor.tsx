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
import {
  ArrowLeft,
  Check,
  Loader2,
  RefreshCw,
  Save,
  Undo2,
} from 'lucide-react';
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
import {
  useHotkeys,
  isMacPlatform,
  isEditableTarget,
} from '../../hooks/useHotkeys';
import VideoPlayer from '../subtitle/VideoPlayer';
import VideoInfo from '../subtitle/VideoInfo';
import SubtitleList from '../subtitle/SubtitleList';
import SubtitleEditToolbar from '../subtitle/SubtitleEditToolbar';
import SpeakerToolbar, { type SpeakerFilter } from './SpeakerToolbar';
import { useNavigationGuard } from '@/context/NavigationGuardContext';
import WaveformTimeline from './WaveformTimeline';
import { timelineSplitPoint } from '../../lib/waveformEditing';
import { useInlineAi } from '../../hooks/useInlineAi';
import InlineAiToolbar from './InlineAiToolbar';
import ContextGlossary from './ContextGlossary';

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
  projectId?: string;
  ensureProject?: () => Promise<string | undefined>;
  file: PendingFile;
  onMarkComplete: () => void;
  onBack: () => void;
}

export default function ProofreadEditor({
  projectId,
  ensureProject,
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
    missedSpeechWarnings,
    updateSubtitles,
    getSubtitles,
    speakers,
    embedSpeakerNames,
    hasSpeakerData,
    videoPath,
    currentSubtitleIndex,
    setCurrentSubtitleIndex,
    videoInfo,
    shouldShowTranslation,
    subtitleTracksForPlayer,
    isLoading,
    loadError,
    retryLoad,
    trackError,
    tracksLoading,
    retryTracks,
    handleSubtitleChange,
    flushPendingEdit,
    handleSave,
    isDirty,
    getIsDirty,
    saveStatus,
    saveError,
    recoveryDraft,
    draftStorageFailed,
    restoreDraft,
    discardDraft,
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
    handleSetCueSpeakers,
    handleCreateSpeaker,
    handleRenameSpeaker,
    handleSetSpeakerColor,
    handleMoveSpeaker,
    handleDeleteSpeaker,
    handleEmbedSpeakerNamesChange,
    // 光标位置
    handleCursorPositionChange,
    getCursorPosition,
  } = useStandaloneSubtitles(config, true);

  const inlineAi = useInlineAi({
    projectId,
    documentKey: JSON.stringify([
      file.id,
      file.selectedSource,
      file.selectedTarget,
      file.sourceLanguage,
      file.targetLanguage,
    ]),
    getSubtitles,
    updateSubtitles,
    shouldShowTranslation,
    sourceLanguage: file.sourceLanguage,
    targetLanguage: file.targetLanguage,
  });

  // 失败字幕批量重翻（复用任务翻译链路）
  const retranslate = useRetranslateFailed({
    documentKey: JSON.stringify([
      file.id,
      file.selectedSource,
      file.selectedTarget,
    ]),
    projectId,
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
    setIsPlaying,
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
  const seekTimeline = useCallback(
    (time: number, index?: number) => {
      playerRef.current?.seekTo(time, 'seconds');
      handleProgress({ playedSeconds: time });
      if (index !== undefined) setCurrentSubtitleIndex(index);
    },
    [handleProgress, playerRef, setCurrentSubtitleIndex],
  );

  const splitAtPlayhead = () => {
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    const row = getSubtitles()[currentSubtitleIndex];
    if (!row) return;
    const time = playerRef.current?.getCurrentTime() ?? currentTime;
    const start = row.startTimeInSeconds ?? 0;
    const end = row.endTimeInSeconds ?? 0;
    const point = timelineSplitPoint(
      row.sourceContent || '',
      (time - start) / (end - start),
    );
    if (point !== null) handleSplitSubtitle(currentSubtitleIndex, point, time);
  };

  // 视图偏好（从 SubtitleList 上提，由编辑工具栏统一控制）：
  // 折叠左侧面板 / 展开全部 / 字号
  const [videoCollapsed, setVideoCollapsed] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [fontScale, setFontScale] = useState<'s' | 'm' | 'l'>('m');
  const [speakerFilter, setSpeakerFilter] = useState<SpeakerFilter>('all');

  useEffect(() => {
    if (!speakerFilter.startsWith('speaker:')) return;
    const speakerId = Number(speakerFilter.slice('speaker:'.length));
    if (!speakers.some((speaker) => speaker.id === speakerId)) {
      setSpeakerFilter('all');
    }
  }, [speakerFilter, speakers]);

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
  const [triggerSplit, setTriggerSplit] = useState(false);

  // 处理从字幕列表点击 AI 优化按钮
  const handleAiOptimizeClick = useCallback(
    (index: number) => {
      handleSubtitleClick(index);
      void inlineAi.run([index]);
    },
    [handleSubtitleClick, inlineAi.run],
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
    setTriggerSplit(false);
  }, []);

  // 注册全局离开守卫（拦截侧栏 NavLink、Cmd+K 命令面板、浏览器前进后退等）
  const { isDialogOpen } = useNavigationGuard(`proofread-editor-${file.id}`, {
    isDirty,
    onSave: handleSave,
    getIsDirty,
    onDiscard: discardDraft,
    title: t('unsavedChangesTitle'),
    description: t('unsavedChangesDesc'),
  });

  // 未保存修改守卫（用于页内返回）
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [isSavingAndBack, setIsSavingAndBack] = useState(false);

  // 全局守卫弹窗打开时自动关闭页内返回弹窗，避免两个弹窗重叠层叠
  useEffect(() => {
    if (isDialogOpen) {
      setShowUnsavedDialog(false);
    }
  }, [isDialogOpen]);

  // 返回列表：有未保存修改时先拦截
  const handleBackClick = useCallback(() => {
    if (isDirty) {
      setShowUnsavedDialog(true);
      return;
    }
    onBack();
  }, [isDirty, onBack]);

  const handleSaveAndBack = useCallback(async () => {
    setIsSavingAndBack(true);
    try {
      const ok = await handleSave();
      if (ok) {
        setShowUnsavedDialog(false);
        onBack();
      }
    } finally {
      setIsSavingAndBack(false);
    }
  }, [handleSave, onBack]);

  const handleDiscardAndBack = useCallback(() => {
    discardDraft();
    setShowUnsavedDialog(false);
    onBack();
  }, [onBack, discardDraft]);

  // 标记完成隐含保存：保证完成态文件与界面一致；保存失败则留在编辑器
  const handleMarkCompleteClick = useCallback(async () => {
    const ok = await handleSave();
    if (ok) onMarkComplete();
  }, [handleSave, onMarkComplete]);

  // Cmd/Ctrl+F：递增 token 通知工具栏展开搜索替换
  const [searchOpenToken, setSearchOpenToken] = useState(0);

  // 编辑器快捷键（4.3 清单）
  useHotkeys([
    {
      combo: 'enter',
      preventDefault: false,
      handler: (event) => {
        if (
          (event.target as HTMLElement)?.closest(
            'button, [role="dialog"], [role="alertdialog"]',
          ) ||
          document.querySelector('[role="dialog"], [role="alertdialog"]')
        )
          return;
        if (inlineAi.accept(currentSubtitleIndex)) event.preventDefault();
      },
    },
    { combo: 'c', handler: splitAtPlayhead },
    {
      combo: 'x',
      handler: () => {
        if (!document.querySelector('[role="dialog"], [role="alertdialog"]'))
          handleMergeSubtitles(currentSubtitleIndex, currentSubtitleIndex + 2);
      },
    },
    { combo: 'mod+b', allowInInput: true, handler: toggleVideoCollapsed },
    { combo: 'mod+s', allowInInput: true, handler: () => void handleSave() },
    {
      combo: 'mod+z',
      allowInInput: true,
      when: (event) =>
        !isEditableTarget(event.target) ||
        !!(event.target as HTMLElement).closest('[data-subtitle-editor]'),
      handler: () => {
        if (canUndo) handleUndo();
      },
    },
    {
      combo: 'shift+mod+z',
      allowInInput: true,
      when: (event) =>
        !isEditableTarget(event.target) ||
        !!(event.target as HTMLElement).closest('[data-subtitle-editor]'),
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
    {
      combo: 'arrowup',
      allowRepeat: true,
      handler: () => goToPreviousSubtitle(),
    },
    {
      combo: 'arrowdown',
      allowRepeat: true,
      handler: () => goToNextSubtitle(),
    },
    {
      combo: 'escape',
      allowInInput: true,
      preventDefault: false,
      handler: (e) => {
        if (
          !document.querySelector('[role="dialog"], [role="alertdialog"]') &&
          !(e.target as HTMLElement)?.closest(
            'input, textarea, [contenteditable="true"]',
          ) &&
          inlineAi.suggestions.has(currentSubtitleIndex)
        ) {
          e.preventDefault();
          inlineAi.dismiss(currentSubtitleIndex);
          return;
        }
        const el = e.target as HTMLElement | null;
        if (el && typeof el.blur === 'function') el.blur();
      },
    },
  ]);

  const modLabel = isMacPlatform() ? '⌘' : 'Ctrl';

  if (isLoading || loadError) {
    return (
      <div className="h-full flex flex-col gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('backToList')}
            onClick={handleBackClick}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="truncate text-sm">{file.fileName}</span>
        </div>
        {isLoading ? (
          <div
            role="status"
            aria-label={t('proofreadLoad.loading')}
            className="flex flex-1 items-center justify-center"
          >
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <div role="alert" className="bg-destructive/10 p-4 text-sm space-y-3">
            <p>{t('proofreadLoad.failed')}</p>
            <p className="text-muted-foreground">{t('proofreadLoad.repair')}</p>
            <details>
              <summary>{commonT('saveState.details')}</summary>
              <p className="break-all whitespace-pre-wrap">{loadError}</p>
            </details>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void retryLoad()}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('proofreadLoad.retry')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <AlertDialog open={Boolean(recoveryDraft)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {commonT('draftRecovery.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {commonT('draftRecovery.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {draftStorageFailed && (
            <p role="alert" className="text-sm text-destructive">
              {commonT('draftRecovery.storageFailed')}
            </p>
          )}
          <AlertDialogFooter>
            <Button variant="outline" onClick={discardDraft}>
              {commonT('draftRecovery.discard')}
            </Button>
            <Button onClick={restoreDraft}>
              {commonT('draftRecovery.restore')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {saveStatus === 'save_error' && (
        <div
          role="alert"
          className="shrink-0 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          {t('saveFailed')}
          <details>
            <summary>{commonT('saveState.details')}</summary>
            <p className="break-words">{saveError}</p>
          </details>
          <Button variant="outline" size="sm" onClick={() => void handleSave()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {commonT('saveState.retry')}
          </Button>
        </div>
      )}
      {draftStorageFailed && (
        <div role="alert" className="shrink-0 bg-warning/10 px-4 py-2 text-sm">
          {commonT('draftRecovery.storageFailed')}
        </div>
      )}
      {trackError && (
        <div role="alert" className="shrink-0 bg-warning/10 px-4 py-2 text-sm">
          <p>{t('proofreadLoad.previewFailed')}</p>
          <details>
            <summary>{commonT('saveState.details')}</summary>
            <p className="break-all whitespace-pre-wrap">{trackError}</p>
          </details>
          <Button
            variant="outline"
            size="sm"
            disabled={tracksLoading}
            onClick={() => void retryTracks()}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('proofreadLoad.retryPreview')}
          </Button>
        </div>
      )}
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
              <span role="status" className="text-xs text-muted-foreground">
                {commonT(
                  `saveState.${saveStatus === 'idle' && isDirty ? 'dirty' : saveStatus}`,
                )}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleSave}
                    disabled={saveStatus === 'saving' || Boolean(recoveryDraft)}
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
                    disabled={saveStatus === 'saving' || Boolean(recoveryDraft)}
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
        {hasSpeakerData && (
          <SpeakerToolbar
            speakers={speakers}
            subtitles={mergedSubtitles}
            filter={speakerFilter}
            onFilterChange={setSpeakerFilter}
            embedSpeakerNames={embedSpeakerNames}
            onEmbedSpeakerNamesChange={handleEmbedSpeakerNamesChange}
            onCreateSpeaker={() => handleCreateSpeaker()}
            onRenameSpeaker={handleRenameSpeaker}
            onSetSpeakerColor={handleSetSpeakerColor}
            onMoveSpeaker={handleMoveSpeaker}
            onDeleteSpeaker={handleDeleteSpeaker}
          />
        )}
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
        <InlineAiToolbar
          control={inlineAi}
          currentIndex={currentSubtitleIndex}
          count={mergedSubtitles.length}
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
              onPlayingChange={setIsPlaying}
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

            <WaveformTimeline
              videoPath={videoPath}
              subtitles={mergedSubtitles}
              selectedIndex={currentSubtitleIndex}
              currentTime={currentTime}
              onSeek={seekTimeline}
              onTimeChange={handleTimeChange}
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
        <ContextGlossary
          documentKey={JSON.stringify([
            file.id,
            file.selectedSource,
            file.selectedTarget,
          ])}
          projectId={projectId}
          ensureProject={ensureProject}
          shouldShowTranslation={shouldShowTranslation}
          getSubtitles={getSubtitles}
          updateSubtitles={updateSubtitles}
        >
          <SubtitleList
            sourceLanguage={file.sourceLanguage}
            targetLanguage={file.targetLanguage}
            inlineAi={inlineAi}
            mergedSubtitles={mergedSubtitles}
            missedSpeechWarnings={missedSpeechWarnings}
            onSeekMissedSpeech={
              hasVideo
                ? (startMs) => {
                    playerRef.current?.seekTo(startMs / 1000, 'seconds');
                  }
                : undefined
            }
            currentSubtitleIndex={currentSubtitleIndex}
            shouldShowTranslation={shouldShowTranslation}
            handleSubtitleClick={handleSubtitleClick}
            handleSubtitleChange={handleSubtitleChange}
            onCommitRow={flushPendingEdit}
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
            speakers={speakers}
            speakerFilter={speakerFilter}
            onCueSpeakersChange={handleSetCueSpeakers}
            onCreateSpeaker={handleCreateSpeaker}
          />
        </ContextGlossary>
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
            <AlertDialogCancel disabled={isSavingAndBack}>
              {t('keepEditing')}
            </AlertDialogCancel>
            <Button
              variant="outline"
              disabled={isSavingAndBack}
              className="gap-1.5"
              onClick={handleDiscardAndBack}
            >
              <Undo2 className="h-4 w-4" />
              {t('discardAndBack')}
            </Button>
            <Button
              disabled={isSavingAndBack}
              className="gap-1.5"
              onClick={handleSaveAndBack}
            >
              <Save className="h-4 w-4" />
              {isSavingAndBack
                ? commonT('saving', '保存中...')
                : t('saveAndBack')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

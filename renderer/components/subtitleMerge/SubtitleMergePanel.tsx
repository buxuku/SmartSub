/**
 * 字幕合并主面板组件 — NLE 三区版式：
 * 左 inspector（样式设置滚动栏）｜右舞台（文件条 + 预览 + 迷你时间轴）｜底部输出行动条
 */

import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Paintbrush,
  Play,
  Video,
  Save,
  Undo2,
  Redo2,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  ListVideo,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PanelHeader } from '@/components/ui/panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';
import { useNavigationGuard } from '@/context/NavigationGuardContext';
import { useHotkeys } from '../../hooks/useHotkeys';
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
  const { t: commonT } = useTranslation('common');
  const [collapsed, setCollapsed] = useState(false);

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
    softContainer,
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
    setSoftContainer,
    setVideoQuality,
    setEncoderMode,

    // 合并操作方法
    startMerge,
    cancelMerge,
    isCancelling,
    canMerge,
    invalidStyleFields,
    reconnectJobs,
    reconnectJob,

    // 其他方法
    openOutputFolder,
    document: composeDocument,
    operationError,
    retryErrors,
    isRetrying,
  } = useSubtitleMerge(hookOptions);

  const guard = useNavigationGuard('subtitle-merge', {
    isDirty: composeDocument.dirty,
    getIsDirty: composeDocument.getIsDirty,
    onSave: composeDocument.save,
    onDiscard: composeDocument.discard,
  });
  const recovering = Boolean(
    composeDocument.recovery || composeDocument.readFailed,
  );
  const shortcutsEnabled = () =>
    !recovering &&
    !guard?.isDialogOpen &&
    !document.querySelector('[role="dialog"], [role="alertdialog"]');
  useHotkeys([
    {
      combo: 'mod+s',
      allowInInput: true,
      handler: () => {
        if (shortcutsEnabled()) void composeDocument.save();
      },
    },
    {
      combo: 'mod+z',
      handler: () => {
        if (shortcutsEnabled()) composeDocument.undo();
      },
    },
    {
      combo: 'shift+mod+z',
      handler: () => {
        if (shortcutsEnabled()) composeDocument.redo();
      },
    },
    {
      combo: 'mod+b',
      allowInInput: true,
      handler: () => {
        if (shortcutsEnabled()) setCollapsed((value) => !value);
      },
    },
  ]);

  const isProcessing = status === 'processing';
  // 软字幕样式由播放器决定，样式设置仅对烧录生效
  const isSoftMux = outputMode === 'softmux';
  const documentBlocked = composeDocument.isBlocked();
  const styleDisabled = isProcessing || isSoftMux || documentBlocked;

  const tools = [
    {
      label: collapsed ? t('showInspector') : t('hideInspector'),
      icon: collapsed ? PanelLeftOpen : PanelLeftClose,
      onClick: () => setCollapsed((value) => !value),
      disabled: false,
    },
    {
      label: commonT('shortcuts.undo'),
      icon: Undo2,
      onClick: composeDocument.undo,
      disabled: isProcessing || !composeDocument.canUndo,
    },
    {
      label: commonT('shortcuts.redo'),
      icon: Redo2,
      onClick: composeDocument.redo,
      disabled: isProcessing || !composeDocument.canRedo,
    },
    {
      label: t('saveComposition'),
      icon: Save,
      onClick: () => void composeDocument.save(),
      disabled: documentBlocked || !composeDocument.ready,
    },
  ];

  return (
    <div className={`flex h-full min-h-0 flex-col gap-2 ${className}`}>
      {reconnectJobs.length > 0 && (
        <section
          aria-label={t('reconnectJobs')}
          className="max-h-40 shrink-0 overflow-auto bg-muted/40 px-3 py-2"
        >
          <p className="mb-1 text-sm">{t('reconnectJobs')}</p>
          {reconnectJobs.map((job) => (
            <Button
              key={job.id}
              variant="ghost"
              className="h-auto w-full justify-start gap-2 py-2 text-left"
              onClick={() => reconnectJob(job.id)}
            >
              <ListVideo className="h-4 w-4 shrink-0" />
              <span className="min-w-0 break-all text-xs">
                {job.outputPath.split(/[/\\]/).pop()} ·{' '}
                {t(
                  job.status === 'running'
                    ? 'reconnectRunning'
                    : 'reconnectQueued',
                )}{' '}
                · {new Date(job.createdAt).toLocaleTimeString()} · {job.id}
              </span>
            </Button>
          ))}
        </section>
      )}
      {composeDocument.lockState !== 'owned' && (
        <div
          role="alert"
          className="shrink-0 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {t(
            composeDocument.lockState === 'error'
              ? 'draftLockFailed'
              : 'draftLocked',
          )}
          {composeDocument.lockState === 'error' && (
            <Button
              variant="outline"
              size="sm"
              className="ml-2"
              onClick={composeDocument.retryLock}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {t('retry')}
            </Button>
          )}
        </div>
      )}
      <AlertDialog open={recovering}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {commonT(
                composeDocument.readFailed
                  ? 'draftRecovery.readFailedTitle'
                  : 'draftRecovery.title',
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {commonT(
                composeDocument.readFailed
                  ? 'draftRecovery.readFailedDescription'
                  : 'draftRecovery.description',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {composeDocument.error && (
            <p role="alert" className="break-all text-sm text-destructive">
              {composeDocument.error}
            </p>
          )}
          <AlertDialogFooter>
            <Button variant="outline" onClick={composeDocument.discard}>
              {commonT('draftRecovery.discard')}
            </Button>
            <Button
              onClick={
                composeDocument.readFailed
                  ? composeDocument.retryRead
                  : composeDocument.restore
              }
            >
              {commonT(
                composeDocument.readFailed
                  ? 'draftRecovery.retryRead'
                  : 'draftRecovery.restore',
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div
        className="flex shrink-0 items-center gap-1"
        role="toolbar"
        aria-label={t('compositionToolbar')}
      >
        <TooltipProvider>
          {tools.map((tool) => (
            <Tooltip key={tool.label}>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label={tool.label}
                  disabled={tool.disabled}
                  onClick={tool.onClick}
                >
                  <tool.icon className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{tool.label}</TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
        <span role="status" className="ml-auto text-xs text-muted-foreground">
          {commonT(
            composeDocument.error
              ? 'saveState.save_error'
              : composeDocument.dirty
                ? 'saveState.dirty'
                : composeDocument.hasSaved
                  ? 'saveState.saved'
                  : 'saveState.idle',
          )}
        </span>
      </div>
      {(composeDocument.error || operationError) && (
        <div
          role="alert"
          className="shrink-0 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <div className="flex items-center justify-between gap-2">
            <span>
              {composeDocument.error
                ? commonT('draftRecovery.storageFailed')
                : t('operationFailed')}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={isRetrying}
              onClick={() => {
                if (composeDocument.error) void composeDocument.save();
                if (operationError) retryErrors();
              }}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {t('retry')}
            </Button>
          </div>
          <details>
            <summary>{commonT('saveState.details')}</summary>
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all text-xs">
              {[composeDocument.error, operationError]
                .filter(Boolean)
                .join('\n')}
            </pre>
          </details>
        </div>
      )}
      <div
        className={`grid min-h-0 flex-1 gap-2.5 ${collapsed ? 'grid-cols-1' : 'grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[332px_minmax(0,1fr)]'}`}
        onPointerUp={composeDocument.endGroup}
        onBlur={composeDocument.endGroup}
      >
        {/* 左 inspector：字幕样式（分区滚动） */}
        <section
          className={`${collapsed ? 'hidden' : 'flex'} min-h-0 flex-col overflow-hidden bg-muted/40`}
          data-testid="compose-inspector"
        >
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
                  subtitlePath={subtitlePath}
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
        </section>

        {/* 右舞台 + 底部输出行动条 */}
        <div className="flex min-h-0 flex-col gap-2.5">
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40">
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
                disabled={isProcessing || documentBlocked}
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
                  onUpdateStyle={documentBlocked ? undefined : updateStyle}
                  softMux={isSoftMux}
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
                    <Button
                      onClick={selectVideo}
                      disabled={isProcessing || documentBlocked}
                    >
                      <Video className="h-4 w-4" />
                      {t('clickToSelectVideo')}
                    </Button>
                  }
                />
              )}
            </div>
          </section>

          {/* 输出行动条：方式 + 画质 + 路径 + 生成（主行动固定右下热区） */}
          <section className="flex-none bg-muted/40">
            <div className="p-2.5">
              <MergeButton
                disabled={documentBlocked}
                invalidStyleFields={invalidStyleFields}
                hasOriginalAudio={videoInfo?.hasAudio}
                outputPath={outputPath}
                outputMode={outputMode}
                softContainer={softContainer}
                onSoftContainerChange={setSoftContainer}
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
                  videoPath &&
                    subtitlePath &&
                    !outputPath &&
                    !isProcessing &&
                    !documentBlocked,
                )}
                onSelectOutputPath={selectOutputPath}
                onOutputModeChange={setOutputMode}
                onVideoQualityChange={setVideoQuality}
                onEncoderModeChange={setEncoderMode}
                onAudioTrackModeChange={setAudioTrackMode}
                onStartMerge={startMerge}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

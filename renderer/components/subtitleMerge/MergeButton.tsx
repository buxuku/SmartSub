/**
 * 输出行动条（NLE 版式底部横条）：输出方式分段控件 + 画质 + 路径 + 生成按钮。
 * 进度/成功/错误状态由预览区浮层呈现。
 */

import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { HelpHint } from '@/components/HelpHint';
import {
  Loader2,
  Play,
  FolderOpen,
  Flame,
  Layers,
  Cpu,
  Zap,
  Replace,
  Blend,
  ListPlus,
} from 'lucide-react';
import type {
  MergeStatus,
  MergeOutputMode,
  VideoQuality,
  EncoderMode,
  HwAccelInfo,
} from '../../../types/subtitleMerge';
import type { AudioTrackMode } from './hooks/useSubtitleMerge';

interface MergeButtonProps {
  outputPath: string | null;
  outputMode: MergeOutputMode;
  videoQuality: VideoQuality;
  /** 生效编码方式（偏好 hardware 但硬件不可用时上游已回落 cpu） */
  encoderMode: EncoderMode;
  /** 硬件编码器探测结果（null=探测中） */
  hwAccelInfo: HwAccelInfo | null;
  /** 本次会话发生过硬件编码失败自动回退 CPU */
  hwFallbackOccurred?: boolean;
  /** 已选配音音轨（显示音轨模式控件） */
  hasAudioTrack?: boolean;
  /** 音轨并入模式 */
  audioTrackMode?: AudioTrackMode;
  /** 作业排队中：前方还有 N 个作业 */
  queuedAhead?: number;
  status: MergeStatus;
  canMerge: boolean;
  /** 文件已就绪但未选输出路径：行动条内联提示 */
  needsOutputPath?: boolean;
  onSelectOutputPath: () => void;
  onOutputModeChange: (mode: MergeOutputMode) => void;
  onVideoQualityChange: (quality: VideoQuality) => void;
  onEncoderModeChange: (mode: EncoderMode) => void;
  onAudioTrackModeChange?: (mode: AudioTrackMode) => void;
  onStartMerge: () => void;
}

export default function MergeButton({
  outputPath,
  outputMode,
  videoQuality,
  encoderMode,
  hwAccelInfo,
  hwFallbackOccurred = false,
  hasAudioTrack = false,
  audioTrackMode = 'replace',
  queuedAhead = 0,
  status,
  canMerge,
  needsOutputPath = false,
  onSelectOutputPath,
  onOutputModeChange,
  onVideoQualityChange,
  onEncoderModeChange,
  onAudioTrackModeChange,
  onStartMerge,
}: MergeButtonProps) {
  const { t } = useTranslation('subtitleMerge');
  const isProcessing = status === 'processing';
  // 画质仅对硬字幕烧录生效；软封装为流复制无损，无需该选项
  const isHardcode = outputMode === 'hardcode';
  // 编码方式仅烧录生效；Linux（平台不支持）隐藏整个控件。
  // 探测未返回（null）期间先按 preload 平台判断隐藏 Linux，避免闪现。
  const isLinux =
    typeof window !== 'undefined' && window.ipc?.platform === 'linux';
  const platformSupportsHw = hwAccelInfo
    ? hwAccelInfo.platformSupported
    : !isLinux;
  const hwAvailable = Boolean(hwAccelInfo?.available);
  const showEncoderControl = isHardcode && platformSupportsHw;
  // 硬件项 tooltip：可用（含编码器名 + 体积权衡）/ 探测中 / 不可用原因
  const hwOptionTooltip = hwAccelInfo
    ? hwAvailable
      ? t('encoderModeHardwareDesc', {
          encoder: hwAccelInfo.encoderLabel,
        })
      : t('encoderModeUnavailable')
    : t('encoderModeDetecting');
  const qualityOptions: Array<{ value: VideoQuality; label: string }> = [
    { value: 'original', label: t('videoQualityOriginal') },
    { value: 'high', label: t('videoQualityHigh') },
    { value: 'standard', label: t('videoQualityStandard') },
  ];

  const modeOptions: Array<{
    value: MergeOutputMode;
    icon: React.ReactNode;
    title: string;
    desc: string;
  }> = [
    {
      value: 'hardcode',
      icon: <Flame className="h-3.5 w-3.5" />,
      title: t('outputModeHardcode'),
      desc: t('outputModeHardcodeDesc'),
    },
    {
      value: 'softmux',
      icon: <Layers className="h-3.5 w-3.5" />,
      title: t('outputModeSoftmux'),
      desc: t('outputModeSoftmuxDesc'),
    },
  ];

  const audioModeOptions: Array<{
    value: AudioTrackMode;
    icon: React.ReactNode;
    title: string;
    desc: string;
  }> = [
    {
      value: 'replace',
      icon: <Replace className="h-3.5 w-3.5" />,
      title: t('audioModeReplace'),
      desc: t('audioModeReplaceDesc'),
    },
    {
      value: 'mix',
      icon: <Blend className="h-3.5 w-3.5" />,
      title: t('audioModeMix'),
      desc: t('audioModeMixDesc'),
    },
    {
      value: 'addTrack',
      icon: <ListPlus className="h-3.5 w-3.5" />,
      title: t('audioModeAddTrack'),
      desc: t('audioModeAddTrackDesc'),
    },
  ];
  // mkv 容器约束提示：软封装或双音轨参与时输出为 mkv
  const showMkvHint =
    hasAudioTrack && audioTrackMode === 'addTrack' && outputMode !== 'softmux';

  return (
    <TooltipProvider>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* 输出方式：分段控件（说明入 tooltip） */}
        <div className="flex h-8 flex-none items-stretch gap-0.5 rounded-md bg-muted p-0.5">
          {modeOptions.map((option) => {
            const active = outputMode === option.value;
            return (
              <Tooltip key={option.value}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => onOutputModeChange(option.value)}
                    className={`flex items-center gap-1.5 rounded-[5px] px-2.5 text-xs transition-colors disabled:opacity-50 ${
                      active
                        ? 'bg-card font-semibold text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {option.icon}
                    {option.title}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{option.desc}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* 导出画质（仅烧录硬字幕生效） */}
        {isHardcode && (
          <div className="flex flex-none items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">
              {t('videoQuality')}
            </Label>
            <HelpHint text={t('videoQualityHint')} />
            <Select
              value={videoQuality}
              onValueChange={(v) => onVideoQualityChange(v as VideoQuality)}
              disabled={isProcessing}
            >
              <SelectTrigger className="w-[112px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {qualityOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* 编码方式（仅烧录硬字幕生效；Linux 隐藏） */}
        {showEncoderControl && (
          <div className="flex flex-none items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">
              {t('encoderMode')}
            </Label>
            <div className="flex h-8 items-stretch gap-0.5 rounded-md bg-muted p-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => onEncoderModeChange('cpu')}
                    className={`flex items-center gap-1.5 rounded-[5px] px-2.5 text-xs transition-colors disabled:opacity-50 ${
                      encoderMode === 'cpu'
                        ? 'bg-card font-semibold text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Cpu className="h-3.5 w-3.5" />
                    {t('encoderModeCpu')}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('encoderModeCpuDesc')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* disabled 元素不触发 tooltip：包一层 span 保证不可用原因可见 */}
                  <span className="flex">
                    <button
                      type="button"
                      disabled={isProcessing || !hwAvailable}
                      onClick={() => onEncoderModeChange('hardware')}
                      className={`flex items-center gap-1.5 rounded-[5px] px-2.5 text-xs transition-colors disabled:opacity-50 ${
                        encoderMode === 'hardware'
                          ? 'bg-card font-semibold text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <Zap className="h-3.5 w-3.5" />
                      {t('encoderModeHardware')}
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-[280px]">
                  {hwOptionTooltip}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}

        {/* 音轨模式（选中配音音轨后显示）：替换 / 混音 / 双轨 */}
        {hasAudioTrack && onAudioTrackModeChange && (
          <div className="flex flex-none items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">
              {t('audioTrackMode')}
            </Label>
            <div className="flex h-8 items-stretch gap-0.5 rounded-md bg-muted p-0.5">
              {audioModeOptions.map((option) => {
                const active = audioTrackMode === option.value;
                return (
                  <Tooltip key={option.value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={() => onAudioTrackModeChange(option.value)}
                        className={`flex items-center gap-1.5 rounded-[5px] px-2.5 text-xs transition-colors disabled:opacity-50 ${
                          active
                            ? 'bg-card font-semibold text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {option.icon}
                        {option.title}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[260px]">
                      {option.desc}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        )}

        {/* 输出路径：占据剩余宽度 */}
        <div className="flex min-w-[240px] flex-1 items-center gap-1.5">
          <Label className="flex-none text-xs text-muted-foreground">
            {t('outputPath')}
          </Label>
          <Input
            type="text"
            value={outputPath || ''}
            readOnly
            placeholder={t('selectOutputPath')}
            className={`min-w-0 flex-1 font-mono text-xs ${
              needsOutputPath ? 'border-warning/60' : ''
            }`}
            onClick={onSelectOutputPath}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={onSelectOutputPath}
            className="flex-none"
            aria-label={t('selectOutputPath')}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
        </div>

        {/* 合并按钮：行动条右端热区 */}
        <Button
          size="lg"
          className="min-w-[132px] flex-none"
          onClick={onStartMerge}
          disabled={!canMerge || isProcessing}
        >
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {queuedAhead > 0
                ? t('queuedAhead', { count: queuedAhead })
                : t('processing')}
            </>
          ) : (
            <>
              <Play className="h-4 w-4" />
              {t('generateVideo')}
            </>
          )}
        </Button>

        {needsOutputPath && (
          <p className="w-full text-[11.5px] text-warning">
            {t('outputPathRequiredHint')}
          </p>
        )}

        {/* 双音轨参与：输出容器为 mkv 的约束提示 */}
        {showMkvHint && (
          <p className="w-full text-[11.5px] text-muted-foreground">
            {t('audioModeMkvHint')}
          </p>
        )}

        {/* 选中硬件加速：体积增大内联提示 */}
        {showEncoderControl && encoderMode === 'hardware' && (
          <p className="w-full text-[11.5px] text-muted-foreground">
            {t('hwAccelSizeHint')}
          </p>
        )}

        {/* 硬件编码失败已自动回退 CPU 重试的提示 */}
        {hwFallbackOccurred && (
          <p className="w-full text-[11.5px] text-warning">
            {t('hwFallbackNotice')}
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}

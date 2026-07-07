/**
 * 左栏配置：引擎 / voice(试听) / 整体语速 / 背景音 / 输出形态 / 导出。
 */
import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Volume2,
  Loader2,
  Download,
  FolderOpen,
  AlertTriangle,
} from 'lucide-react';
import type { UseDubbingReturn } from '../../hooks/useDubbing';
import type {
  DubbingBackgroundMode,
  DubbingOutputMode,
} from '../../../types/dubbing';

export default function DubbingConfigPanel({ dub }: { dub: UseDubbingReturn }) {
  const { t } = useTranslation('dubbing');
  const {
    engineOptions,
    activeEngine,
    activeVoice,
    config,
    updateConfig,
    previewVoice,
    previewing,
    running,
    exporting,
    videoPath,
    mediaIsAudio,
    canExport,
    exportDubbing,
    exportResult,
    openOutputFolder,
    actionError,
    summary,
  } = dub;

  const disabled = running || exporting;
  // 无媒体或媒体为纯音频（无视频流）：只能导出纯音频。
  const outputLocked = !videoPath || mediaIsAudio;
  const effectiveOutput: DubbingOutputMode = outputLocked
    ? 'audioOnly'
    : config.output;

  return (
    <div className="space-y-4 p-4">
      {/* 引擎 */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('engine')}</label>
        <Select
          value={activeEngine?.key ?? ''}
          onValueChange={(v) => updateConfig({ engineKey: v, voice: '' })}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder={t('engineEmpty')} />
          </SelectTrigger>
          <SelectContent>
            {engineOptions.map((o) => (
              <SelectItem key={o.key} value={o.key} disabled={!o.ready}>
                {o.kind === 'local' ? '💻 ' : '☁️ '}
                {o.label}
                {o.unstable ? ` · ${t('unstableTag')}` : ''}
                {!o.ready ? ` · ${t('notReady')}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {engineOptions.filter((o) => o.ready).length === 0 && (
          <p className="text-xs text-muted-foreground">{t('noEngineHint')}</p>
        )}
        {activeEngine?.unstable && (
          <p className="flex items-start gap-1 text-xs text-amber-600">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            {t('edgeUnstableHint')}
          </p>
        )}
      </div>

      {/* 音色 + 试听 */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('voice')}</label>
        <div className="flex items-center gap-1.5">
          <Select
            value={activeVoice}
            onValueChange={(v) => updateConfig({ voice: v })}
            disabled={disabled || !activeEngine}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder={t('voicePlaceholder')} />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {(activeEngine?.voices ?? []).map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="shrink-0"
            title={t('previewVoice')}
            aria-label={t('previewVoice')}
            disabled={disabled || previewing || !activeVoice}
            onClick={() => previewVoice()}
          >
            {previewing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* 整体语速 */}
      <div className="space-y-1.5">
        <label className="flex items-center justify-between text-sm font-medium">
          {t('globalSpeed')}
          <span className="tabular-nums text-muted-foreground">
            {config.globalSpeed.toFixed(2)}x
          </span>
        </label>
        <Slider
          min={0.5}
          max={2}
          step={0.05}
          value={[config.globalSpeed]}
          onValueChange={([v]) => updateConfig({ globalSpeed: v })}
          disabled={disabled}
        />
      </div>

      <Separator />

      {/* 背景音 */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('background')}</label>
        <Select
          value={config.background}
          onValueChange={(v) =>
            updateConfig({ background: v as DubbingBackgroundMode })
          }
          disabled={disabled || effectiveOutput === 'audioOnly'}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mute">{t('backgroundMute')}</SelectItem>
            <SelectItem value="duck">{t('backgroundDuck')}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('backgroundHint')}</p>
      </div>

      {/* 输出形态 */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('outputMode')}</label>
        <Select
          value={effectiveOutput}
          onValueChange={(v) =>
            updateConfig({ output: v as DubbingOutputMode })
          }
          disabled={disabled || outputLocked}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="audioOnly">{t('outputAudioOnly')}</SelectItem>
            <SelectItem value="replaceTrack" disabled={outputLocked}>
              {t('outputReplace')}
            </SelectItem>
            <SelectItem value="mixTrack" disabled={outputLocked}>
              {t('outputMix')}
            </SelectItem>
            <SelectItem value="addTrack" disabled={outputLocked}>
              {t('outputAddTrack')}
            </SelectItem>
          </SelectContent>
        </Select>
        {outputLocked && (
          <p className="text-xs text-muted-foreground">
            {t('outputLockedHint')}
          </p>
        )}
      </div>

      {effectiveOutput === 'audioOnly' && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t('audioFormat')}</label>
          <Select
            value={config.audioFormat}
            onValueChange={(v) =>
              updateConfig({ audioFormat: v as 'wav' | 'mp3' })
            }
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="wav">WAV</SelectItem>
              <SelectItem value="mp3">MP3</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* 超长处置 + 顺延字幕 */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{t('overflow')}</label>
        <Select
          value={config.overflow}
          onValueChange={(v) =>
            updateConfig({ overflow: v as 'truncate' | 'shift' })
          }
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="truncate">{t('overflowTruncate')}</SelectItem>
            <SelectItem value="shift">{t('overflowShift')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">
          {t('exportShiftedSubtitle')}
        </label>
        <Switch
          checked={config.exportShiftedSubtitle}
          onCheckedChange={(v) => updateConfig({ exportShiftedSubtitle: v })}
          disabled={disabled}
        />
      </div>

      <Separator />

      {/* 导出 */}
      <div className="space-y-2">
        {summary.overlong > 0 && (
          <p className="flex items-start gap-1 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            {t('overlongExportHint', { count: summary.overlong })}
          </p>
        )}
        <Button
          className="w-full"
          onClick={exportDubbing}
          disabled={!canExport}
        >
          {exporting ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-1.5 h-4 w-4" />
          )}
          {t('export')}
        </Button>
        {actionError && (
          <p className="break-all rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {actionError}
          </p>
        )}
        {exportResult && (
          <div className="space-y-1 rounded-md border bg-muted/40 p-2 text-xs">
            <p className="font-medium">{t('exportDone')}</p>
            <p className="break-all text-muted-foreground">
              {exportResult.outputPath}
            </p>
            {exportResult.shiftedSubtitlePath && (
              <p className="break-all text-muted-foreground">
                {exportResult.shiftedSubtitlePath}
              </p>
            )}
            {exportResult.skippedIndexes.length > 0 && (
              <p className="text-amber-600">
                {t('exportSkipped', {
                  count: exportResult.skippedIndexes.length,
                })}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="mt-1 h-7 w-full"
              onClick={openOutputFolder}
            >
              <FolderOpen className="mr-1 h-3.5 w-3.5" />
              {t('openFolder')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 左栏配置（仅设置项，主操作在文件条右端的 DubbingActionBar）：
 * 声音设置（引擎/音色/语速）→ 导出设置（形态/格式/背景音）→ 高级选项（折叠）。
 * 克隆引擎（zipvoice）空音色时内嵌创建向导入口。
 */
import React, { useState } from 'react';
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Volume2,
  Loader2,
  AlertTriangle,
  Mic2,
  ChevronDown,
} from 'lucide-react';
import type { UseDubbingReturn } from '../../hooks/useDubbing';
import type {
  DubbingBackgroundMode,
  DubbingOutputMode,
  DubbingOverlapMode,
} from '../../../types/dubbing';
import CloneVoiceWizard from '../voiceClone/CloneVoiceWizard';

export default function DubbingConfigPanel({ dub }: { dub: UseDubbingReturn }) {
  const { t } = useTranslation('dubbing');
  const { t: cloneT } = useTranslation('voiceClone');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const {
    engineOptions,
    activeEngine,
    activeVoice,
    activeVoiceLang,
    subtitleLanguage,
    config,
    updateConfig,
    refreshEngines,
    previewVoice,
    previewing,
    running,
    exporting,
    videoPath,
    mediaIsAudio,
    summary,
  } = dub;

  // 跨语言克隆提示：音色语言（克隆音色才携带）≠ 字幕主导语言。
  const crossLingual =
    !!activeVoiceLang &&
    !!subtitleLanguage &&
    activeVoiceLang !== subtitleLanguage;
  const langName = (l: 'zh' | 'en') =>
    l === 'zh' ? cloneT('langZh') : cloneT('langEn');

  const disabled = running || exporting;
  // 无媒体或媒体为纯音频（无视频流）：只能导出纯音频。
  const outputLocked = !videoPath || mediaIsAudio;
  const effectiveOutput: DubbingOutputMode = outputLocked
    ? 'audioOnly'
    : config.output;

  // 高级选项里有条件项（并行/克隆质量/重叠），至少始终含超长处置与顺延字幕。
  return (
    <div className="space-y-4 p-4">
      {/* ── 声音设置 ── */}
      <p className="label-caps">{t('groupVoice')}</p>

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
        {/* 克隆引擎：音色即「我的音色」，空态/追加都从这里进向导 */}
        {activeEngine?.cloneOnly && (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5"
            disabled={disabled}
            onClick={() => setWizardOpen(true)}
          >
            <Mic2 className="h-3.5 w-3.5" />
            {cloneT('createVoice')}
          </Button>
        )}
        {/* 跨语言克隆预期提示（可合成，但韵律带原语言口音） */}
        {crossLingual && (
          <p className="flex items-start gap-1 text-xs text-amber-600">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            {cloneT('crossLingualHint', {
              voiceLang: langName(activeVoiceLang!),
              textLang: langName(subtitleLanguage!),
            })}
          </p>
        )}
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

      {/* ── 导出设置 ── */}
      <p className="label-caps">{t('groupExport')}</p>

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

      {/* 背景音（仅视频类输出生效） */}
      {effectiveOutput !== 'audioOnly' && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium">{t('background')}</label>
          <Select
            value={config.background}
            onValueChange={(v) =>
              updateConfig({ background: v as DubbingBackgroundMode })
            }
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mute">{t('backgroundMute')}</SelectItem>
              <SelectItem value="duck">{t('backgroundDuck')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <Separator />

      {/* ── 高级选项（默认折叠） ── */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="-mx-2 flex w-full items-center justify-between rounded px-2 py-2 hover:bg-muted/50">
          <span className="label-caps">{t('groupAdvanced')}</span>
          <ChevronDown
            className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          {/* 本地并行合成（仅本地引擎）：每路一份模型驻留内存 */}
          {activeEngine?.kind === 'local' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {t('localConcurrency')}
              </label>
              <Select
                value={String(config.localConcurrency ?? 1)}
                onValueChange={(v) =>
                  updateConfig({ localConcurrency: Number(v) })
                }
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">{t('localConcurrency1')}</SelectItem>
                  <SelectItem value="2">2</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                </SelectContent>
              </Select>
              {(config.localConcurrency ?? 1) > 1 && (
                <p className="text-xs text-muted-foreground">
                  {t('localConcurrencyHint')}
                </p>
              )}
            </div>
          )}

          {/* 克隆质量档（仅克隆引擎） */}
          {activeEngine?.cloneOnly && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('cloneQuality')}</label>
              <Select
                value={config.cloneQuality ?? 'standard'}
                onValueChange={(v) =>
                  updateConfig({ cloneQuality: v as 'standard' | 'high' })
                }
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">
                    {t('cloneQualityStandard')}
                  </SelectItem>
                  <SelectItem value="high">{t('cloneQualityHigh')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('cloneQualityHint')}
              </p>
            </div>
          )}

          {/* 重叠处理模式：仅当会话存在重叠行时展示（顺延是默认、多轨是升级） */}
          {summary.overlap > 0 && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('overlapMode')}</label>
              <Select
                value={config.overlapMode ?? 'shift'}
                onValueChange={(v) =>
                  updateConfig({ overlapMode: v as DubbingOverlapMode })
                }
                disabled={disabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shift">{t('overlapShift')}</SelectItem>
                  <SelectItem value="mix">{t('overlapMix')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('overlapModeHint', { count: summary.overlap })}
              </p>
            </div>
          )}

          {/* 超长处置 */}
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
                <SelectItem value="truncate">
                  {t('overflowTruncate')}
                </SelectItem>
                <SelectItem value="shift">{t('overflowShift')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* 顺延字幕 */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">
              {t('exportShiftedSubtitle')}
            </label>
            <Switch
              checked={config.exportShiftedSubtitle}
              onCheckedChange={(v) =>
                updateConfig({ exportShiftedSubtitle: v })
              }
              disabled={disabled}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* 创建克隆音色向导（克隆引擎入口） */}
      <CloneVoiceWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onCreated={(voice) => {
          refreshEngines();
          updateConfig({ voice: voice.id });
        }}
      />
    </div>
  );
}

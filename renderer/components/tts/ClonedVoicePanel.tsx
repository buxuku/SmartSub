/**
 * 「配音服务」右栏：单个克隆音色的管理面板——试听样本（播放/重生成）、
 * 参考音频回放、参考文本、创建期质检报告、重命名、删除（确认框）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  AlertTriangle,
  Check,
  Download,
  Info,
  Loader2,
  Pencil,
  Play,
  RotateCcw,
  Square,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'lib/utils';
import type {
  ClonedVoiceView,
  VoiceQualityIssue,
} from '../../../types/voiceClone';
import { CLONE_TARGET_RANGES } from '../../../types/voiceClone';

function mediaUrl(p: string): string {
  return `media://${encodeURIComponent(p)}?v=${Date.now()}`;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export default function ClonedVoicePanel({
  voice,
  onRename,
  onRemove,
  onRegenerateSample,
  onVolcRefreshStatus,
  onVolcRetrain,
  onExport,
}: {
  voice: ClonedVoiceView;
  onRename: (id: string, name: string) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  onRegenerateSample: (id: string) => Promise<unknown>;
  onVolcRefreshStatus?: (id: string) => Promise<unknown>;
  onVolcRetrain?: (id: string) => Promise<unknown>;
  onExport?: (id: string) => Promise<unknown>;
}) {
  const { t } = useTranslation('voiceClone');
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(voice.name);
  const [regenerating, setRegenerating] = useState(false);
  const [volcBusy, setVolcBusy] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const stopAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingKey(null);
  }, []);
  useEffect(() => () => stopAudio(), [stopAudio]);
  // 切换选中音色时复位播放与编辑态。
  useEffect(() => {
    stopAudio();
    setEditing(false);
    setNameDraft(voice.name);
  }, [voice.id, voice.name, stopAudio]);

  const playFile = useCallback(
    (p: string, key: string) => {
      if (playingKey === key) {
        stopAudio();
        return;
      }
      stopAudio();
      const audio = new Audio(mediaUrl(p));
      audioRef.current = audio;
      setPlayingKey(key);
      audio.onended = () => setPlayingKey(null);
      audio.onerror = () => setPlayingKey(null);
      audio.play().catch(() => setPlayingKey(null));
    },
    [playingKey, stopAudio],
  );

  const sec = (ms: number) => (ms / 1000).toFixed(1);
  const target = CLONE_TARGET_RANGES[voice.engine];

  const issueText = (issue: VoiceQualityIssue): string => {
    switch (issue.code) {
      case 'no-speech':
        return t('issueNoSpeech');
      case 'too-short':
        return t('issueTooShort', { seconds: sec(issue.value ?? 0) });
      case 'short-for-engine':
        return t('issueShortForEngine', {
          seconds: sec(issue.value ?? 0),
          ideal: Math.round(target.idealMinMs / 1000),
        });
      case 'low-snr':
        return t('issueLowSnr', { db: issue.value ?? 0 });
      case 'clipping':
        return t('issueClipping');
      case 'low-volume':
        return t('issueLowVolume');
      case 'low-speech-ratio':
        return t('issueLowSpeechRatio', {
          percent: Math.round((issue.value ?? 0) * 100),
        });
      case 'long-silence':
        return t('issueLongSilence', { seconds: sec(issue.value ?? 0) });
      default:
        return issue.code;
    }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const r = (await onRegenerateSample(voice.id)) as {
        success?: boolean;
        error?: string;
      } | null;
      if (r && r.success === false && r.error) toast.error(r.error);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('panelIntro')}
        </p>
      </div>

      {/* 元信息 + 重命名 */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[11px]">
          {voice.engine === 'zipvoice'
            ? t('engineZipvoice')
            : voice.engine === 'elevenlabs'
              ? t('engineElevenlabs')
              : t('engineVolcengine')}
        </Badge>
        <Badge variant="outline" className="text-[11px]">
          {voice.language === 'zh' ? t('langZh') : t('langEn')}
        </Badge>
        {voice.engine === 'volcengine' && (
          <Badge
            variant="outline"
            className={cn(
              'text-[11px]',
              voice.trainStatus === 'ready' && 'border-success/50 text-success',
              voice.trainStatus === 'training' &&
                'border-amber-500/50 text-amber-600',
              voice.trainStatus === 'failed' &&
                'border-destructive/50 text-destructive',
            )}
          >
            {voice.trainStatus === 'ready'
              ? t('trainReady')
              : voice.trainStatus === 'failed'
                ? t('trainFailed')
                : t('training')}
          </Badge>
        )}
        {voice.quality && (
          <span className="text-xs text-muted-foreground">
            {t('metaSpeech')}{' '}
            {t('seconds', { value: sec(voice.quality.speechMs) })}
          </span>
        )}
        {voice.engine === 'volcengine' &&
          voice.volcTrainingTimesLeft != null && (
            <span className="text-xs text-muted-foreground">
              {t('trainingTimesLeft', { count: voice.volcTrainingTimesLeft })}
            </span>
          )}
        <div className="ml-auto flex items-center gap-1.5">
          {editing ? (
            <div className="flex items-center gap-1">
              <Input
                value={nameDraft}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameDraft.trim()) {
                    onRename(voice.id, nameDraft.trim());
                    setEditing(false);
                  }
                  if (e.key === 'Escape') setEditing(false);
                }}
                className="h-7 w-40 text-sm"
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={!nameDraft.trim()}
                onClick={() => {
                  onRename(voice.id, nameDraft.trim());
                  setEditing(false);
                }}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setEditing(false)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                setNameDraft(voice.name);
                setEditing(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              {t('rename')}
            </Button>
          )}
        </div>
      </div>

      {/* 试听样本 + 参考音频 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!voice.sampleWavPath}
          onClick={() =>
            voice.sampleWavPath && playFile(voice.sampleWavPath, 'sample')
          }
        >
          {playingKey === 'sample' ? (
            <Square className="mr-1 h-3.5 w-3.5" />
          ) : (
            <Volume2 className="mr-1 h-3.5 w-3.5" />
          )}
          {t('playSample')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!voice.refWavPath}
          onClick={() => voice.refWavPath && playFile(voice.refWavPath, 'ref')}
        >
          {playingKey === 'ref' ? (
            <Square className="mr-1 h-3.5 w-3.5" />
          ) : (
            <Play className="mr-1 h-3.5 w-3.5" />
          )}
          {t('playRef')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={regenerating}
          onClick={handleRegenerate}
        >
          {regenerating ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
          )}
          {t('regenSample')}
        </Button>
        {!voice.sampleWavPath && (
          <span className="text-xs text-muted-foreground">
            {t('sampleMissing')}
          </span>
        )}
      </div>

      {/* 火山训练状态动作：训练中可刷新；失败可复用参考音频重训 */}
      {voice.engine === 'volcengine' && voice.trainStatus !== 'ready' && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          {voice.trainStatus === 'failed' ? (
            <p className="w-full text-xs text-destructive">
              {t('trainFailedDesc', { error: voice.trainError || '' })}
            </p>
          ) : (
            <p className="w-full text-xs text-muted-foreground">
              {t('trainingSlowNotice')}
            </p>
          )}
          {onVolcRefreshStatus && voice.trainStatus !== 'failed' && (
            <Button
              size="sm"
              variant="outline"
              disabled={volcBusy}
              onClick={async () => {
                setVolcBusy(true);
                try {
                  const r = (await onVolcRefreshStatus(voice.id)) as {
                    success?: boolean;
                    error?: string;
                  } | null;
                  if (r && r.success === false && r.error) toast.error(r.error);
                } finally {
                  setVolcBusy(false);
                }
              }}
            >
              {volcBusy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
              )}
              {t('refreshStatus')}
            </Button>
          )}
          {onVolcRetrain && voice.trainStatus === 'failed' && (
            <Button
              size="sm"
              variant="outline"
              disabled={volcBusy}
              onClick={async () => {
                setVolcBusy(true);
                try {
                  const r = (await onVolcRetrain(voice.id)) as {
                    success?: boolean;
                    error?: string;
                  } | null;
                  if (r && r.success === false && r.error) toast.error(r.error);
                } finally {
                  setVolcBusy(false);
                }
              }}
            >
              {volcBusy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
              )}
              {t('retrain')}
            </Button>
          )}
        </div>
      )}

      {/* 参考文本 */}
      {voice.refText && (
        <div className="space-y-1 rounded-lg border p-3">
          <p className="text-xs font-medium">{t('refTextTitle')}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {voice.refText}
          </p>
        </div>
      )}

      {/* 质检报告 */}
      {voice.quality && (
        <div
          className={cn(
            'space-y-2 rounded-lg border p-3',
            voice.quality.verdict === 'good' && 'border-success/40',
            voice.quality.verdict === 'fair' && 'border-amber-500/40',
            voice.quality.verdict === 'poor' && 'border-destructive/40',
          )}
        >
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium">{t('qualityReport')}</p>
            <Badge
              variant="outline"
              className={cn(
                'text-[11px]',
                voice.quality.verdict === 'good' &&
                  'border-success/50 text-success',
                voice.quality.verdict === 'fair' &&
                  'border-amber-500/50 text-amber-600',
                voice.quality.verdict === 'poor' &&
                  'border-destructive/50 text-destructive',
              )}
            >
              {voice.quality.verdict === 'good'
                ? t('verdictGood')
                : voice.quality.verdict === 'fair'
                  ? t('verdictFair')
                  : t('verdictPoor')}
            </Badge>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {t('metaSnr')} {voice.quality.snrDb}dB
            </span>
          </div>
          {voice.quality.issues.length > 0 && (
            <ul className="space-y-1 text-xs">
              {voice.quality.issues.map((issue, i) => (
                <li
                  key={`${issue.code}-${i}`}
                  className={cn(
                    'flex items-start gap-1.5',
                    issue.severity === 'error' && 'text-destructive',
                    issue.severity === 'warning' &&
                      'text-amber-700 dark:text-amber-400',
                    issue.severity === 'info' && 'text-muted-foreground',
                  )}
                >
                  {issue.severity === 'info' ? (
                    <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  )}
                  {issueText(issue)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 来源与删除 */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {voice.sourceFile && (
          <span className="truncate" title={voice.sourceFile}>
            {t('metaSource')}: {baseName(voice.sourceFile)}
          </span>
        )}
        <span>
          {t('metaCreated')}: {new Date(voice.createdAt).toLocaleString()}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {onExport && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={async () => {
                const r = (await onExport(voice.id)) as {
                  success?: boolean;
                  data?: string;
                  error?: string;
                  cancelled?: boolean;
                } | null;
                if (r?.success && r.data) {
                  toast.success(t('exportDone', { path: r.data }));
                } else if (r && r.success === false && r.error) {
                  toast.error(r.error);
                }
              }}
            >
              <Download className="h-3.5 w-3.5" />
              {t('exportVoice')}
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('deleteVoice')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('deleteDesc')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => onRemove(voice.id)}
                >
                  {t('deleteConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}

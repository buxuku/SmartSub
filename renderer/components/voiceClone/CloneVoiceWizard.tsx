/**
 * 克隆音色创建向导（四步 Dialog）：
 * ① 选素材（引擎选择 + 拖放/浏览/最近任务）→ ② 波形选段 + 实时质检 →
 * ③ 参考文本（字幕预填 / ASR 转写 / 手动；仅本地 zipvoice）→
 * ④ 命名 + 授权（火山分支：槽位 + 服务端开关）+ 创建 + A/B 试听。
 * 分析会话驻留 main（analysisId），关闭/换素材时释放；
 * 火山训练轮询超窗以「训练中」入库，面板可刷新。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'next-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  FileAudio,
  History,
  Info,
  Loader2,
  Mic2,
  Music4,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Timer,
  UserRound,
  Volume2,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from 'lib/utils';
import SegmentPicker, { type SegmentRange } from './SegmentPicker';
import type {
  ClonedVoiceView,
  CloneAnalysisView,
  VoiceCloneEngine,
  VoiceQualityIssue,
  VoiceQualityReport,
} from '../../../types/voiceClone';
import {
  CLONE_TARGET_RANGES,
  absorbCuesFrom,
  dominantTextLanguage,
  type SubtitleCueLite,
} from '../../../types/voiceClone';
import type { WorkItem } from '../../../types/workItem';
import {
  TTS_ELEVENLABS,
  TTS_VOLCENGINE,
  getTtsProviderType,
  isTtsProviderConfigured,
  type TtsProvider,
} from '../../../types/ttsProvider';

const MEDIA_EXT =
  /\.(mp3|wav|m4a|flac|aac|ogg|opus|mp4|mkv|avi|mov|webm|flv|ts)$/i;

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function mediaUrl(p: string): string {
  return `media://${encodeURIComponent(p)}?v=${Date.now()}`;
}

interface RecentCandidate {
  key: string;
  label: string;
  videoPath: string;
  subtitlePath?: string;
}

function collectRecent(items: WorkItem[]): RecentCandidate[] {
  const out: RecentCandidate[] = [];
  for (const item of items) {
    for (const f of item.pipelineFiles ?? []) {
      if (!f.filePath) continue;
      out.push({
        key: `${item.id}:${f.uuid}`,
        label: f.fileName ?? baseName(f.filePath),
        videoPath: f.filePath,
        subtitlePath: f.srtFile || f.translatedSrtFile,
      });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

type WizardStep = 1 | 2 | 3 | 4;

export default function CloneVoiceWizard({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (voice: ClonedVoiceView) => void;
}) {
  const { t } = useTranslation('voiceClone');
  const [engine, setEngine] = useState<VoiceCloneEngine>('zipvoice');
  const target = CLONE_TARGET_RANGES[engine];

  const [step, setStep] = useState<WizardStep>(1);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [sourceSubtitle, setSourceSubtitle] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentCandidate[]>([]);
  const [modelInstalled, setModelInstalled] = useState(true);
  /** 火山复刻可用的豆包实例（合成 Key 就绪；训练凭据在 Step4 前再校验）。 */
  const [volcProvider, setVolcProvider] = useState<TtsProvider | null>(null);
  /** ElevenLabs 可用实例（IVC 与合成共用同一 API Key）。 */
  const [elevenProvider, setElevenProvider] = useState<TtsProvider | null>(
    null,
  );
  const [speakerId, setSpeakerId] = useState('');
  const [denoise, setDenoise] = useState(false);
  const [mss, setMss] = useState(false);
  /** ElevenLabs 分支：服务端去背景音开关。 */
  const [removeNoise, setRemoveNoise] = useState(false);
  /** zipvoice 分支：本地 gtcrn 降噪（噪音黄牌素材的兜底）。 */
  const [localDenoise, setLocalDenoise] = useState(false);
  /** 降噪试听（Step2 即时对比）：临时产物路径 + 降噪后 SNR。 */
  const [denoisePreview, setDenoisePreview] = useState<{
    wavPath: string;
    snrDb: number;
  } | null>(null);
  const [denoising, setDenoising] = useState(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<CloneAnalysisView | null>(null);

  const [range, setRange] = useState<SegmentRange>({ startMs: 0, endMs: 0 });
  const [report, setReport] = useState<VoiceQualityReport | null>(null);
  /** 字幕行清单（来源含字幕时按行选段）。 */
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCueLite[]>([]);

  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [refText, setRefText] = useState('');
  const [transcribing, setTranscribing] = useState(false);
  const [textSource, setTextSource] = useState<
    'subtitle' | 'asr' | 'manual' | null
  >(null);
  const [asrEngineLabel, setAsrEngineLabel] = useState('');
  const [asrUnavailable, setAsrUnavailable] = useState(false);

  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<ClonedVoiceView | null>(null);

  // ── 播放（选区试听 / A/B 对比共用一个 audio）───────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const stopAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingKey(null);
  }, []);
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
  const playRange = useCallback(() => {
    if (!analysis) return;
    if (playingKey === 'range') {
      stopAudio();
      return;
    }
    stopAudio();
    const audio = new Audio(mediaUrl(analysis.analysisWavPath));
    audioRef.current = audio;
    setPlayingKey('range');
    audio.currentTime = range.startMs / 1000;
    const endSec = range.endMs / 1000;
    audio.ontimeupdate = () => {
      if (audio.currentTime >= endSec) {
        audio.pause();
        setPlayingKey(null);
      }
    };
    audio.onended = () => setPlayingKey(null);
    audio.onerror = () => setPlayingKey(null);
    audio.play().catch(() => setPlayingKey(null));
  }, [analysis, range, playingKey, stopAudio]);

  // ── 生命周期：打开时取最近任务 + 模型状态；关闭时释放会话并重置 ─────────────
  const analysisIdRef = useRef<string | null>(null);
  analysisIdRef.current = analysisId;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open) return;
    window.ipc
      .invoke('getWorkItems')
      .then((items: WorkItem[]) => setRecent(collectRecent(items ?? [])))
      .catch(() => setRecent([]));
    window.ipc
      .invoke('getTtsModelStatus')
      .then((s: any) => {
        const m = (s?.models ?? []).find((x: any) => x.cloneOnly);
        setModelInstalled(!!m?.installed);
      })
      .catch(() => setModelInstalled(true));
    window.ipc
      .invoke('getTtsProviders')
      .then((providers: TtsProvider[]) => {
        const configured = (providers ?? []).filter((x) =>
          isTtsProviderConfigured(x, getTtsProviderType(x.type)),
        );
        setVolcProvider(
          configured.find((x) => x.type === TTS_VOLCENGINE) ?? null,
        );
        setElevenProvider(
          configured.find((x) => x.type === TTS_ELEVENLABS) ?? null,
        );
      })
      .catch(() => {
        setVolcProvider(null);
        setElevenProvider(null);
      });
  }, [open]);

  const resetAll = useCallback(() => {
    stopAudio();
    const staleId = analysisIdRef.current;
    if (staleId) {
      window.ipc.invoke('voiceClone:disposeAnalysis', { analysisId: staleId });
    }
    setStep(1);
    setEngine('zipvoice');
    setSourcePath(null);
    setSourceSubtitle(null);
    setAnalyzing(false);
    setAnalyzeError(null);
    setAnalysisId(null);
    setAnalysis(null);
    setRange({ startMs: 0, endMs: 0 });
    setReport(null);
    setSubtitleCues([]);
    setRefText('');
    setTextSource(null);
    setAsrEngineLabel('');
    setAsrUnavailable(false);
    setName('');
    setConsent(false);
    setSpeakerId('');
    setDenoise(false);
    setMss(false);
    setRemoveNoise(false);
    setLocalDenoise(false);
    setDenoisePreview(null);
    setDenoising(false);
    setCreating(false);
    setCreateError(null);
    setCreated(null);
  }, [stopAudio]);

  useEffect(() => {
    if (!open) resetAll();
  }, [open, resetAll]);

  // ── Step1 → 分析 ────────────────────────────────────────────────────────────
  const startAnalyze = useCallback(
    async (src: string, subtitlePath?: string) => {
      stopAudio();
      const staleId = analysisIdRef.current;
      if (staleId) {
        window.ipc.invoke('voiceClone:disposeAnalysis', {
          analysisId: staleId,
        });
        setAnalysisId(null);
        setAnalysis(null);
      }
      setSourcePath(src);
      setSourceSubtitle(subtitlePath ?? null);
      setStep(2);
      setAnalyzing(true);
      setAnalyzeError(null);
      setReport(null);
      setRefText('');
      setTextSource(null);
      setSubtitleCues([]);
      if (subtitlePath) {
        window.ipc
          .invoke('voiceClone:subtitleCues', { subtitlePath })
          .then((r: any) => {
            if (r?.success) setSubtitleCues(r.data ?? []);
          })
          .catch(() => setSubtitleCues([]));
      }
      try {
        const r = await window.ipc.invoke('voiceClone:analyze', {
          sourcePath: src,
          engine,
        });
        // 向导已被关闭：立即释放刚建的会话。
        if (!openRef.current) {
          if (r.success && r.data?.analysisId) {
            window.ipc.invoke('voiceClone:disposeAnalysis', {
              analysisId: r.data.analysisId,
            });
          }
          return;
        }
        if (!r.success) {
          setAnalyzeError(r.error || t('analyzeFailed'));
          return;
        }
        const view = r.data as CloneAnalysisView & { analysisId: string };
        setAnalysisId(view.analysisId);
        setAnalysis(view);
        const initial: SegmentRange = view.suggestion
          ? { startMs: view.suggestion.startMs, endMs: view.suggestion.endMs }
          : { startMs: 0, endMs: Math.min(view.durationMs, target.idealMaxMs) };
        setRange(initial);
      } catch (e) {
        setAnalyzeError(e instanceof Error ? e.message : String(e));
      } finally {
        setAnalyzing(false);
      }
    },
    [engine, stopAudio, t, target.idealMaxMs],
  );

  const pickSource = useCallback(async () => {
    const r = await window.ipc.invoke('voiceClone:pickSource');
    if (r.success && r.data) startAnalyze(r.data);
  }, [startAnalyze]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      for (const file of Array.from(e.dataTransfer.files)) {
        const p = window.ipc.getPathForFile(file);
        if (p && MEDIA_EXT.test(p)) {
          startAnalyze(p);
          return;
        }
      }
    },
    [startAnalyze],
  );

  // ── Step2：选区变化 → 防抖质检（降噪试听随选区失效）──────────────────────
  useEffect(() => {
    if (!analysisId || range.endMs <= range.startMs) return;
    setDenoisePreview(null);
    const timer = setTimeout(async () => {
      const r = await window.ipc.invoke('voiceClone:inspectRange', {
        analysisId,
        startMs: range.startMs,
        endMs: range.endMs,
        engine,
      });
      if (r.success && r.data?.report) {
        setReport(r.data.report as VoiceQualityReport);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [analysisId, range, engine]);

  // 本地降噪试听：切选区 → gtcrn → 播放对比（结果缓存到选区变化）。
  const previewDenoise = useCallback(async () => {
    if (!analysisId || denoising) return;
    if (denoisePreview) {
      playFile(denoisePreview.wavPath, 'denoise-preview');
      return;
    }
    setDenoising(true);
    try {
      const r = await window.ipc.invoke('voiceClone:denoisePreview', {
        analysisId,
        startMs: range.startMs,
        endMs: range.endMs,
      });
      if (r.success && r.data?.wavPath) {
        setDenoisePreview(r.data);
        playFile(r.data.wavPath, 'denoise-preview');
      }
    } finally {
      setDenoising(false);
    }
  }, [analysisId, denoising, denoisePreview, range, playFile]);

  const hasError = !!report?.issues.some((i) => i.severity === 'error');

  // ── Step3：进入时自动取参考文本 ─────────────────────────────────────────────
  const autoFillText = useCallback(async () => {
    if (!analysisId) return;
    setTranscribing(true);
    setAsrUnavailable(false);
    try {
      if (sourceSubtitle) {
        const r = await window.ipc.invoke('voiceClone:subtitleTextForRange', {
          subtitlePath: sourceSubtitle,
          startMs: range.startMs,
          endMs: range.endMs,
        });
        const text = String(r.data ?? '').trim();
        if (r.success && text) {
          setRefText(text);
          // 音色语言以素材实际语言为准（英文视频 + 默认中文的陷阱）。
          setLanguage(dominantTextLanguage(text));
          setTextSource('subtitle');
          return;
        }
      }
      const r = await window.ipc.invoke('voiceClone:transcribeRange', {
        analysisId,
        startMs: range.startMs,
        endMs: range.endMs,
        language,
      });
      if (r.success && r.data?.available && r.data?.text) {
        setRefText(r.data.text);
        setLanguage(dominantTextLanguage(String(r.data.text)));
        setAsrEngineLabel(r.data.engineLabel || 'ASR');
        setTextSource('asr');
      } else {
        setAsrUnavailable(true);
        setTextSource('manual');
      }
    } finally {
      setTranscribing(false);
    }
  }, [analysisId, sourceSubtitle, range, language]);

  const nextFromStep2 = useCallback(() => {
    stopAudio();
    if (engine !== 'zipvoice') {
      // 火山/EL：云端接口不需要参考文本，直进命名保存步。
      setStep(4);
      return;
    }
    setStep(3);
    if (!refText.trim()) autoFillText();
  }, [autoFillText, engine, refText, stopAudio]);

  // ── Step4：创建 ─────────────────────────────────────────────────────────────
  const create = useCallback(async () => {
    if (!analysisId || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const r = await window.ipc.invoke('voiceClone:create', {
        analysisId,
        startMs: range.startMs,
        endMs: range.endMs,
        engine,
        language,
        name: name.trim(),
        refText: refText.trim(),
        ...(engine === 'zipvoice' ? { localDenoise } : {}),
        ...(engine === 'volcengine' && volcProvider
          ? {
              volc: {
                providerId: String(volcProvider.id),
                speakerId: speakerId.trim(),
                denoise,
                mss,
              },
            }
          : {}),
        ...(engine === 'elevenlabs' && elevenProvider
          ? {
              eleven: {
                providerId: String(elevenProvider.id),
                removeNoise,
              },
            }
          : {}),
      });
      if (!r.success) {
        setCreateError(r.error || 'create failed');
        return;
      }
      const voice = r.data as ClonedVoiceView;
      setCreated(voice);
      onCreated?.(voice);
    } finally {
      setCreating(false);
    }
  }, [
    analysisId,
    creating,
    range,
    engine,
    language,
    name,
    refText,
    volcProvider,
    speakerId,
    denoise,
    mss,
    elevenProvider,
    removeNoise,
    onCreated,
  ]);

  // 「换一段重试」：删除刚创建的音色,回第②步。
  const tryAnother = useCallback(async () => {
    stopAudio();
    if (created) {
      await window.ipc.invoke('voiceClone:remove', { id: created.id });
      setCreated(null);
    }
    setCreateError(null);
    setStep(2);
  }, [created, stopAudio]);

  const finish = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // ── 渲染 ────────────────────────────────────────────────────────────────────
  // 云端分支（火山/EL）跳过参考文本步（接口不需要转写文本），stepper 显示三步。
  const skipTextStep = engine !== 'zipvoice';
  const steps: Array<{ id: WizardStep; label: string }> = [
    { id: 1, label: t('stepSource') },
    { id: 2, label: t('stepSegment') },
    ...(skipTextStep ? [] : [{ id: 3 as WizardStep, label: t('stepText') }]),
    { id: 4, label: t('stepSave') },
  ];

  const sec = (ms: number) => (ms / 1000).toFixed(1);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden sm:max-w-[640px]">
        <DialogHeader className="pb-3">
          <DialogTitle className="flex items-center gap-2">
            <Mic2 className="h-4 w-4 text-primary" />
            {t('wizardTitle')}
          </DialogTitle>
          {/* 步骤指示 */}
          <div className="flex items-center gap-1 pt-2">
            {steps.map((s, i) => (
              <React.Fragment key={s.id}>
                {i > 0 && (
                  <div
                    className={cn(
                      'h-px flex-1',
                      step > s.id - 1 ? 'bg-primary/50' : 'bg-border',
                    )}
                  />
                )}
                <div
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs',
                    step === s.id
                      ? 'bg-primary/10 font-medium text-primary'
                      : step > s.id
                        ? 'text-primary/70'
                        : 'text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-full text-[10px]',
                      step === s.id
                        ? 'bg-primary text-primary-foreground'
                        : step > s.id
                          ? 'bg-primary/20 text-primary'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {step > s.id ? '✓' : i + 1}
                  </span>
                  {s.label}
                </div>
              </React.Fragment>
            ))}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto py-3">
          {/* ── Step 1 选素材 ── */}
          {step === 1 && (
            <div className="space-y-3">
              {/* 引擎选择：本地免费 / 火山复刻（需槽位）/ ElevenLabs IVC */}
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    {
                      id: 'zipvoice' as VoiceCloneEngine,
                      enabled: true,
                      title: t('engineZipvoiceTitle'),
                      desc: t('engineZipvoiceDesc'),
                    },
                    {
                      id: 'volcengine' as VoiceCloneEngine,
                      enabled: !!volcProvider,
                      title: t('engineVolcTitle'),
                      desc: volcProvider
                        ? t('engineVolcDesc')
                        : t('engineVolcNeedProvider'),
                    },
                    {
                      id: 'elevenlabs' as VoiceCloneEngine,
                      enabled: !!elevenProvider,
                      title: t('engineElevenTitle'),
                      desc: elevenProvider
                        ? t('engineElevenDesc')
                        : t('engineElevenNeedProvider'),
                    },
                  ] satisfies Array<{
                    id: VoiceCloneEngine;
                    enabled: boolean;
                    title: string;
                    desc: string;
                  }>
                ).map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    disabled={!card.enabled}
                    onClick={() => {
                      setEngine(card.id);
                      // 已有分析时选区按新档位收口（质检卡随 engine 即时复检）。
                      if (analysis) {
                        const max = CLONE_TARGET_RANGES[card.id].maxMs;
                        setRange((r) =>
                          r.endMs - r.startMs > max
                            ? { startMs: r.startMs, endMs: r.startMs + max }
                            : r,
                        );
                      }
                    }}
                    className={cn(
                      'rounded-lg border p-3 text-left transition-colors',
                      engine === card.id
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                        : 'hover:bg-muted/40',
                      !card.enabled && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <p className="text-sm font-medium">{card.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {card.desc}
                    </p>
                  </button>
                ))}
              </div>
              {engine === 'zipvoice' && !modelInstalled && (
                <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t('modelMissingHint')}
                </p>
              )}
              <button
                type="button"
                onClick={pickSource}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed border-input px-4 py-10 text-center transition-colors hover:border-primary/50 hover:bg-muted/40"
              >
                <FileAudio className="h-8 w-8 text-muted-foreground" />
                <span className="text-sm font-medium">{t('dropHint')}</span>
                <span className="text-xs text-muted-foreground">
                  {t('dropSubHint')}
                </span>
              </button>

              {recent.length > 0 && (
                <div className="flex justify-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <History className="mr-1 h-3.5 w-3.5" />
                        {t('fromRecent')}
                        <ChevronDown className="ml-0.5 h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center" className="max-w-md">
                      {recent.map((c) => (
                        <DropdownMenuItem
                          key={c.key}
                          onClick={() =>
                            startAnalyze(c.videoPath, c.subtitlePath)
                          }
                        >
                          <span className="truncate">{c.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}

              {/* 素材要求指引 */}
              <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
                <p className="mb-2 flex items-center gap-1 text-xs font-medium">
                  <Sparkles className="h-3.5 w-3.5 text-primary" />
                  {t('guideTitle')}
                </p>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex items-start gap-1.5">
                    <Music4 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t('guideQuiet')}
                  </li>
                  <li className="flex items-start gap-1.5">
                    <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t('guideSingle')}
                  </li>
                  <li className="flex items-start gap-1.5">
                    <Timer className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t('guideDuration')}
                  </li>
                  <li className="flex items-start gap-1.5">
                    <Volume2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {t('guideTone')}
                  </li>
                </ul>
              </div>
            </div>
          )}

          {/* ── Step 2 选段 + 质检 ── */}
          {step === 2 && (
            <div className="space-y-3">
              {sourcePath && (
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={sourcePath}
                >
                  {baseName(sourcePath)}
                </p>
              )}
              {analyzing ? (
                <div className="flex flex-col items-center gap-2 py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <p className="text-sm">{t('analyzing')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('analyzingLong')}
                  </p>
                </div>
              ) : analyzeError ? (
                <div className="flex flex-col items-center gap-3 py-10">
                  <p className="break-all rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                    {t('analyzeFailed')}: {analyzeError}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setStep(1)}
                  >
                    {t('reselectSource')}
                  </Button>
                </div>
              ) : analysis ? (
                <>
                  <SegmentPicker
                    envelope={analysis.envelope}
                    durationMs={analysis.durationMs}
                    speechSegments={analysis.speechSegments}
                    value={range}
                    onChange={setRange}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={playRange}
                      disabled={range.endMs <= range.startMs}
                    >
                      {playingKey === 'range' ? (
                        <Square className="mr-1 h-3.5 w-3.5" />
                      ) : (
                        <Play className="mr-1 h-3.5 w-3.5" />
                      )}
                      {playingKey === 'range' ? t('stopPlay') : t('playRange')}
                    </Button>
                    {analysis.suggestion && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setRange({
                            startMs: analysis.suggestion!.startMs,
                            endMs: analysis.suggestion!.endMs,
                          })
                        }
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                        {t('resetSuggestion')}
                      </Button>
                    )}
                    {report && (
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {t('selectionDuration')}{' '}
                        {t('seconds', { value: sec(report.durationMs) })} ·{' '}
                        {t('speechDuration')}{' '}
                        {t('seconds', { value: sec(report.speechMs) })}
                      </span>
                    )}
                  </div>

                  {/* 质检评分卡 */}
                  {report && (
                    <div
                      className={cn(
                        'space-y-2 rounded-lg border p-3',
                        report.verdict === 'good' &&
                          'border-success/40 bg-success/5',
                        report.verdict === 'fair' &&
                          'border-amber-500/40 bg-amber-500/5',
                        report.verdict === 'poor' &&
                          'border-destructive/40 bg-destructive/5',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">
                          {t('qualityTitle')}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[11px]',
                            report.verdict === 'good' &&
                              'border-success/50 text-success',
                            report.verdict === 'fair' &&
                              'border-amber-500/50 text-amber-600',
                            report.verdict === 'poor' &&
                              'border-destructive/50 text-destructive',
                          )}
                        >
                          {report.verdict === 'good'
                            ? t('verdictGood')
                            : report.verdict === 'fair'
                              ? t('verdictFair')
                              : t('verdictPoor')}
                        </Badge>
                      </div>
                      {report.issues.length > 0 && (
                        <ul className="space-y-1 text-xs">
                          {report.issues.map((issue, i) => (
                            <li
                              key={`${issue.code}-${i}`}
                              className={cn(
                                'flex items-start gap-1.5',
                                issue.severity === 'error' &&
                                  'text-destructive',
                                issue.severity === 'warning' &&
                                  'text-amber-700 dark:text-amber-400',
                                issue.severity === 'info' &&
                                  'text-muted-foreground',
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
                      {report.issues.length === 0 && (
                        <p className="flex items-center gap-1.5 text-xs text-success">
                          <CheckCircle2 className="h-3 w-3" />
                          {t('verdictGood')}
                        </p>
                      )}
                    </div>
                  )}

                  {/* 处理选项（与质检结果同屏）：本地降噪试听 / 火山服务端开关 */}
                  {report && (
                    <div className="space-y-2 rounded-lg border p-3">
                      {engine === 'zipvoice' ? (
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-xs font-medium">
                              {t('localDenoise')}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {t('localDenoiseHint')}
                              {report.issues.some(
                                (i) => i.code === 'low-snr',
                              ) && (
                                <span className="ml-1 text-amber-600">
                                  {t('localDenoiseSuggest')}
                                </span>
                              )}
                              {denoisePreview && (
                                <span className="ml-1 text-success">
                                  {t('denoiseSnrAfter', {
                                    before: report.snrDb,
                                    after: denoisePreview.snrDb,
                                  })}
                                </span>
                              )}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={denoising}
                              onClick={previewDenoise}
                            >
                              {denoising ? (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                              ) : playingKey === 'denoise-preview' ? (
                                <Square className="mr-1 h-3.5 w-3.5" />
                              ) : (
                                <Play className="mr-1 h-3.5 w-3.5" />
                              )}
                              {t('denoisePreview')}
                            </Button>
                            <Switch
                              checked={localDenoise}
                              onCheckedChange={setLocalDenoise}
                            />
                          </div>
                        </div>
                      ) : engine === 'volcengine' ? (
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-xs font-medium">
                                {t('denoise')}
                              </p>
                              <p className="text-[11px] text-muted-foreground">
                                {t('denoiseHint')}
                                {report.issues.some(
                                  (i) => i.code === 'low-snr',
                                ) && (
                                  <span className="ml-1 text-amber-600">
                                    {t('denoiseSuggest')}
                                  </span>
                                )}
                              </p>
                            </div>
                            <Switch
                              checked={denoise}
                              onCheckedChange={setDenoise}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-xs font-medium">{t('mss')}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {t('mssHint')}
                              </p>
                            </div>
                            <Switch checked={mss} onCheckedChange={setMss} />
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-xs font-medium">
                              {t('removeNoise')}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {t('removeNoiseHint')}
                              {report.issues.some(
                                (i) => i.code === 'low-snr',
                              ) && (
                                <span className="ml-1 text-amber-600">
                                  {t('denoiseSuggest')}
                                </span>
                              )}
                            </p>
                          </div>
                          <Switch
                            checked={removeNoise}
                            onCheckedChange={setRemoveNoise}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* 按字幕行选段（来源含字幕时）：点行吸收相邻行成选区 */}
                  {subtitleCues.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t('cueListTitle')}
                      </p>
                      <div className="max-h-36 overflow-y-auto rounded-md border">
                        {subtitleCues.map((cue, i) => {
                          const inRange =
                            cue.endMs > range.startMs &&
                            cue.startMs < range.endMs;
                          return (
                            <button
                              key={`${cue.startMs}-${i}`}
                              type="button"
                              onClick={() => {
                                const next = absorbCuesFrom(
                                  subtitleCues,
                                  i,
                                  target,
                                );
                                if (next && analysis) {
                                  setRange({
                                    startMs: next.startMs,
                                    endMs: Math.min(
                                      next.endMs,
                                      analysis.durationMs,
                                    ),
                                  });
                                }
                              }}
                              className={cn(
                                'flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs transition-colors hover:bg-muted/60',
                                inRange && 'bg-primary/10',
                              )}
                            >
                              <span className="shrink-0 tabular-nums text-muted-foreground">
                                {new Date(cue.startMs)
                                  .toISOString()
                                  .slice(11, 19)}
                              </span>
                              <span className="min-w-0 flex-1 truncate">
                                {cue.text}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}

          {/* ── Step 3 参考文本 ── */}
          {step === 3 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">{t('language')}</label>
                <Select
                  value={language}
                  onValueChange={(v) => setLanguage(v as 'zh' | 'en')}
                >
                  <SelectTrigger className="h-8 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zh">{t('langZh')}</SelectItem>
                    <SelectItem value="en">{t('langEn')}</SelectItem>
                  </SelectContent>
                </Select>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={playRange}>
                    {playingKey === 'range' ? (
                      <Square className="mr-1 h-3.5 w-3.5" />
                    ) : (
                      <Play className="mr-1 h-3.5 w-3.5" />
                    )}
                    {playingKey === 'range' ? t('stopPlay') : t('playRange')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={transcribing}
                    onClick={autoFillText}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    {t('retranscribe')}
                  </Button>
                </div>
              </div>

              {transcribing ? (
                <div className="flex items-center justify-center gap-2 rounded-md border py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('transcribing')}
                </div>
              ) : (
                <Textarea
                  value={refText}
                  onChange={(e) => setRefText(e.target.value)}
                  rows={6}
                  placeholder={t('textPlaceholder')}
                  className="resize-none"
                />
              )}

              {textSource === 'subtitle' && !transcribing && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Info className="h-3 w-3" />
                  {t('fromSubtitle')}
                </p>
              )}
              {textSource === 'asr' && !transcribing && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Info className="h-3 w-3" />
                  {t('transcribedBy', { engine: asrEngineLabel })}
                </p>
              )}
              {asrUnavailable && !transcribing && (
                <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t('transcribeUnavailable')}
                </p>
              )}
              <p className="flex items-start gap-1.5 rounded-md bg-primary/5 p-2 text-xs text-muted-foreground">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                {t('textHint')}
              </p>
            </div>
          )}

          {/* ── Step 4 命名保存 ── */}
          {step === 4 && (
            <div className="space-y-4">
              {!created ? (
                <>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">
                      {t('nameLabel')}
                      <span className="text-destructive"> *</span>
                    </label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t('namePlaceholder')}
                      disabled={creating}
                    />
                  </div>

                  {/* 云端分支（火山/EL）：语言（试听样本用）；火山另需槽位 ID */}
                  {engine !== 'zipvoice' && (
                    <div className="flex items-center gap-2">
                      <label className="text-sm font-medium">
                        {t('language')}
                      </label>
                      <Select
                        value={language}
                        onValueChange={(v) => setLanguage(v as 'zh' | 'en')}
                        disabled={creating}
                      >
                        <SelectTrigger className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="zh">{t('langZh')}</SelectItem>
                          <SelectItem value="en">{t('langEn')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {engine === 'volcengine' && (
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">
                        {t('speakerIdLabel')}
                        <span className="text-destructive"> *</span>
                      </label>
                      <Input
                        value={speakerId}
                        onChange={(e) => setSpeakerId(e.target.value)}
                        placeholder={t('speakerIdPlaceholder')}
                        className="font-mono"
                        disabled={creating}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('speakerIdHint')}
                      </p>
                    </div>
                  )}
                  {engine === 'elevenlabs' && (
                    <p className="flex items-start gap-1.5 rounded-md bg-primary/5 p-2 text-xs text-muted-foreground">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {t('elevenSlotHint')}
                    </p>
                  )}

                  {/* 处理开关已前置到第②步质检卡旁；此处仅回显选中的处理项 */}
                  {(localDenoise || denoise || mss || removeNoise) && (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Info className="h-3 w-3" />
                      {[
                        engine === 'zipvoice' && localDenoise
                          ? t('localDenoise')
                          : null,
                        engine === 'volcengine' && denoise
                          ? t('denoise')
                          : null,
                        engine === 'volcengine' && mss ? t('mss') : null,
                        engine === 'elevenlabs' && removeNoise
                          ? t('removeNoise')
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}

                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <Checkbox
                      checked={consent}
                      onCheckedChange={(v) => setConsent(v === true)}
                      disabled={creating}
                      className="mt-0.5"
                    />
                    <span>{t('consent')}</span>
                  </label>
                  {createError && (
                    <p className="break-all rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                      {createError}
                    </p>
                  )}
                  {creating && (
                    <div className="flex items-center justify-center gap-2 rounded-md border py-8 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {engine === 'volcengine'
                        ? t('creatingVolc')
                        : t('creating')}
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-col items-center gap-1 py-2">
                    <CheckCircle2 className="h-8 w-8 text-success" />
                    <p className="text-sm font-medium">{t('createdTitle')}</p>
                    <p className="text-xs text-muted-foreground">
                      {created.trainStatus === 'training'
                        ? t('trainingSlowNotice')
                        : t('createdDesc')}
                    </p>
                  </div>
                  {created.trainStatus === 'failed' && (
                    <p className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {t('trainFailedDesc', {
                        error: created.trainError || '',
                      })}
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      disabled={!created.refWavPath}
                      onClick={() =>
                        created.refWavPath &&
                        playFile(created.refWavPath, 'ab-orig')
                      }
                    >
                      {playingKey === 'ab-orig' ? (
                        <Square className="mr-1.5 h-4 w-4" />
                      ) : (
                        <Play className="mr-1.5 h-4 w-4" />
                      )}
                      {t('playOriginal')}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!created.sampleWavPath}
                      onClick={() =>
                        created.sampleWavPath &&
                        playFile(created.sampleWavPath, 'ab-clone')
                      }
                    >
                      {playingKey === 'ab-clone' ? (
                        <Square className="mr-1.5 h-4 w-4" />
                      ) : (
                        <Volume2 className="mr-1.5 h-4 w-4" />
                      )}
                      {t('playClone')}
                    </Button>
                  </div>
                  {!created.sampleWavPath &&
                    created.trainStatus !== 'training' && (
                      <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {t('sampleFailed')}
                      </p>
                    )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部导航 */}
        <div className="flex items-center justify-between border-t pt-3">
          <div>
            {step > 1 && !created && (
              <Button
                variant="ghost"
                size="sm"
                disabled={creating || analyzing}
                onClick={() => {
                  stopAudio();
                  setStep((s) =>
                    s === 4 && skipTextStep ? 2 : ((s - 1) as WizardStep),
                  );
                }}
              >
                <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                {t('back')}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === 2 && (
              <Button
                size="sm"
                disabled={analyzing || !analysis || !report || hasError}
                onClick={nextFromStep2}
              >
                {t('next')}
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            )}
            {step === 3 && (
              <Button
                size="sm"
                disabled={transcribing || !refText.trim()}
                onClick={() => {
                  stopAudio();
                  setStep(4);
                }}
              >
                {t('next')}
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            )}
            {step === 4 && !created && (
              <Button
                size="sm"
                disabled={
                  creating ||
                  !name.trim() ||
                  !consent ||
                  (engine === 'volcengine' &&
                    !speakerId.trim().startsWith('S_'))
                }
                onClick={create}
              >
                {creating ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="mr-1 h-3.5 w-3.5" />
                )}
                {t('create')}
              </Button>
            )}
            {step === 4 && created && (
              <>
                <Button variant="outline" size="sm" onClick={tryAnother}>
                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                  {t('tryAnother')}
                </Button>
                <Button size="sm" onClick={finish}>
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                  {t('done')}
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

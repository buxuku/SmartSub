import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Loader2, Mic, Play, RotateCcw, Square, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from 'lib/utils';
import type { VoiceCloneEngine } from '../../../types/voiceClone';

/** 录音硬上限：防误留后台录音（长素材自动选段本就兜底）。 */
const REC_MAX_MS = 5 * 60 * 1000;

/** 目标时长提示（秒）：给自动选段留出足够余量。 */
const REC_TARGET_SEC: Record<VoiceCloneEngine, number> = {
  zipvoice: 15,
  volcengine: 30,
  elevenlabs: 60,
};

type RecPhase = 'idle' | 'recording' | 'recorded';

/**
 * 向导 Step1 的麦克风录音面板：电平条 + 计时 + 朗读脚本 + 试听/重录，
 * 确认后录音落盘临时目录并回调路径（进入既有分析链路）。
 * 采集关闭浏览器级降噪/回声消除/AGC（保真优先，响度归一交给 prepare 管线）。
 */
export default function MicRecorder({
  engine,
  onConfirm,
  onCancel,
}: {
  engine: VoiceCloneEngine;
  onConfirm: (recordingPath: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('voiceClone');
  const [phase, setPhase] = useState<RecPhase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  const startAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const cleanupCapture = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setLevel(0);
  }, []);

  const cleanupPreview = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      cleanupCapture();
      cleanupPreview();
    },
    [cleanupCapture, cleanupPreview],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const start = useCallback(async () => {
    setMicError(null);
    setDenied(false);
    cleanupPreview();
    blobRef.current = null;
    // darwin：主进程 TCC 前置请求（打包态 getUserMedia 不弹系统窗）。
    try {
      const r = await window.ipc.invoke('voiceClone:requestMicAccess');
      if (r?.success && r.data === false) {
        setDenied(true);
        return;
      }
    } catch {
      /* 权限探测失败不阻断，交给 getUserMedia 兜底 */
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setDenied(true);
      } else {
        setMicError(String((e as Error)?.message ?? e));
      }
      return;
    }
    streamRef.current = stream;

    // 电平条：AnalyserNode RMS → 0..1（对数感知留给样式指数）。
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: 128_000,
    });
    recorderRef.current = rec;
    chunksRef.current = [];
    rec.ondataavailable = (ev) => {
      if (ev.data?.size > 0) chunksRef.current.push(ev.data);
    };
    rec.onstop = () => {
      blobRef.current = new Blob(chunksRef.current, { type: mime });
      cleanupCapture();
      setPhase('recorded');
    };
    rec.start(1000);
    startAtRef.current = Date.now();
    setElapsedMs(0);
    setPhase('recording');
    timerRef.current = setInterval(() => {
      const ms = Date.now() - startAtRef.current;
      setElapsedMs(ms);
      if (ms >= REC_MAX_MS) stop();
    }, 200);
  }, [cleanupCapture, cleanupPreview, stop]);

  const preview = useCallback(() => {
    if (playing) {
      cleanupPreview();
      return;
    }
    const blob = blobRef.current;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    previewUrlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    setPlaying(true);
    audio.onended = () => setPlaying(false);
    audio.onerror = () => setPlaying(false);
    audio.play().catch(() => setPlaying(false));
  }, [playing, cleanupPreview]);

  const confirm = useCallback(async () => {
    const blob = blobRef.current;
    if (!blob || saving) return;
    setSaving(true);
    try {
      const buffer = await blob.arrayBuffer();
      const r = await window.ipc.invoke('voiceClone:saveRecording', {
        buffer: new Uint8Array(buffer),
      });
      if (r?.success && r.data) {
        cleanupPreview();
        onConfirm(String(r.data));
      } else {
        setMicError(r?.error || 'save failed');
      }
    } finally {
      setSaving(false);
    }
  }, [saving, onConfirm, cleanupPreview]);

  const mmss = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t('recTitle')}</p>
        <p className="text-xs text-muted-foreground">
          {t('recTargetHint', { seconds: REC_TARGET_SEC[engine] })}
        </p>
      </div>

      {/* 朗读脚本 */}
      <div className="rounded-md bg-muted/40 p-3">
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          {t('recScriptTitle')}
        </p>
        <p className="text-sm leading-relaxed">{t('recScript')}</p>
      </div>

      {/* 电平 + 计时 */}
      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-100',
              phase === 'recording' ? 'bg-destructive' : 'bg-primary/40',
            )}
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
        <span
          className={cn(
            'shrink-0 font-mono text-sm tabular-nums',
            phase === 'recording' && 'text-destructive',
          )}
        >
          {mmss(elapsedMs)}
        </span>
      </div>

      {denied && (
        <p className="rounded-md bg-warning/10 p-2 text-xs text-warning">
          {t('micDenied')}
        </p>
      )}
      {micError && (
        <p className="break-all rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          {t('micError', { error: micError })}
        </p>
      )}

      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          {t('back')}
        </Button>
        <div className="flex items-center gap-2">
          {phase === 'idle' && (
            <Button size="sm" onClick={start}>
              <Mic className="mr-1.5 h-4 w-4" />
              {t('recStart')}
            </Button>
          )}
          {phase === 'recording' && (
            <Button size="sm" variant="destructive" onClick={stop}>
              <Square className="mr-1.5 h-4 w-4" />
              {t('recStop')}
            </Button>
          )}
          {phase === 'recorded' && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={preview}
              >
                {playing ? (
                  <Square className="mr-1.5 h-4 w-4" />
                ) : (
                  <Play className="mr-1.5 h-4 w-4" />
                )}
                {t('recPreview')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => {
                  cleanupPreview();
                  blobRef.current = null;
                  setElapsedMs(0);
                  setPhase('idle');
                  start();
                }}
              >
                <RotateCcw className="mr-1.5 h-4 w-4" />
                {t('recRedo')}
              </Button>
              <Button size="sm" disabled={saving} onClick={confirm}>
                {saving ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-4 w-4" />
                )}
                {t('recUse')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

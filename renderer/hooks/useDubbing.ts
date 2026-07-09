/**
 * 配音工作台单一状态 hook（subtitleMerge 范式）：
 * 文件/引擎/配置/行状态/进度/导出全收敛于此，组件只渲染。
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import useLocalStorageState from './useLocalStorageState';
import { isAudioPath } from 'lib/utils';
import type {
  DubbingConfig,
  DubbingCueView,
  DubbingSessionView,
  DubbingProgressPayload,
  DubbingBatchView,
  DubbingExportView,
  DubbingEngineSelection,
  DubbingBackgroundMode,
  DubbingOutputMode,
  DubbingAudioFormat,
  DubbingOverflowMode,
  DubbingOverlapMode,
} from '../../types/dubbing';
import {
  getTtsProviderType,
  isTtsProviderConfigured,
  resolveTtsVoiceLabel,
} from '../../types/ttsProvider';
import { dominantTextLanguage } from '../../types/voiceClone';

/** UI 的引擎候选项（本地模型 / 云服务商实例统一形状）。 */
export interface DubbingEngineOption {
  key: string; // local:<modelId> | cloud:<providerId>
  kind: 'local' | 'cloud';
  label: string;
  /** 本地=已安装；云=已配置（isTtsProviderConfigured，必填字段全就绪）。 */
  ready: boolean;
  /** Edge 等不稳定通道标注。 */
  unstable?: boolean;
  /** 云服务商类型 id（计费口径提示按类型分流）。 */
  providerType?: string;
  /** 克隆引擎（zipvoice）：voice 池 = 我的音色，空态引导创建。 */
  cloneOnly?: boolean;
  /** lang 仅克隆音色携带（跨语言提示用）。 */
  voices: Array<{ id: string; label: string; lang?: 'zh' | 'en' }>;
  defaultVoiceId?: string;
}

/** 可持久化的工作台配置（localStorage 记忆，下次进入恢复）。 */
interface PersistedDubbingConfig {
  engineKey: string;
  voice: string;
  globalSpeed: number;
  background: DubbingBackgroundMode;
  output: DubbingOutputMode;
  audioFormat: DubbingAudioFormat;
  overflow: DubbingOverflowMode;
  overlapMode?: DubbingOverlapMode;
  exportShiftedSubtitle: boolean;
}

const DEFAULT_PERSISTED: PersistedDubbingConfig = {
  engineKey: '',
  voice: '',
  globalSpeed: 1,
  background: 'mute',
  output: 'replaceTrack',
  audioFormat: 'wav',
  overflow: 'truncate',
  overlapMode: 'shift',
  exportShiftedSubtitle: false,
};

/**
 * 行级回放 URL：重合成会把 wav 原地覆盖（路径不变），Chromium 按 URL 缓存
 * 媒体响应会播出旧音频（换 voice 重合成听不到变化）——时间戳查询串击穿缓存
 * （media 协议 handler 取路径前会剥离查询串）。
 */
function mediaUrl(p: string): string {
  return `media://${encodeURIComponent(p)}?v=${Date.now()}`;
}

export type DubbingUiPhase =
  | 'idle' // 未加载字幕
  | 'ready' // 已加载,可开始
  | 'synthesizing' // 批量合成中
  | 'exporting' // 导出中
  | 'done'; // 有合成结果

function parseEngineKey(key: string): DubbingEngineSelection | null {
  if (key.startsWith('local:')) {
    return { kind: 'local', modelId: key.slice('local:'.length) };
  }
  if (key.startsWith('cloud:')) {
    return { kind: 'cloud', providerId: key.slice('cloud:'.length) };
  }
  return null;
}

export function useDubbing(options?: {
  initialSubtitlePath?: string;
  initialVideoPath?: string;
}) {
  // ── 文件与会话 ────────────────────────────────────────────────────────────
  const [subtitlePath, setSubtitlePath] = useState<string | null>(
    options?.initialSubtitlePath || null,
  );
  const [videoPath, setVideoPath] = useState<string | null>(
    options?.initialVideoPath || null,
  );
  const [session, setSession] = useState<DubbingSessionView | null>(null);
  const [cues, setCues] = useState<DubbingCueView[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── 引擎候选 ──────────────────────────────────────────────────────────────
  const [engineOptions, setEngineOptions] = useState<DubbingEngineOption[]>([]);

  const refreshEngines = useCallback(async () => {
    const opts: DubbingEngineOption[] = [];
    // 克隆音色清单：zipvoice 引擎的 voice 池 + 火山克隆音色注入豆包实例。
    let clonedVoices: Array<{
      id: string;
      name: string;
      engine: string;
      language?: 'zh' | 'en';
      speakerId?: string;
      providerId?: string;
      trainStatus?: string;
    }> = [];
    try {
      const r = await window.ipc.invoke('voiceClone:list');
      if (r?.success) clonedVoices = r.data ?? [];
    } catch {
      /* ignore */
    }
    try {
      const status = await window.ipc.invoke('getTtsModelStatus');
      for (const m of status?.models ?? []) {
        const voices = m.cloneOnly
          ? clonedVoices
              .filter((v) => v.engine === 'zipvoice')
              .map((v) => ({ id: v.id, label: v.name, lang: v.language }))
          : (m.voices ?? []).map((v: any) => ({
              id: v.id,
              label: v.label,
            }));
        opts.push({
          key: `local:${m.id}`,
          kind: 'local',
          label: m.displayName ?? m.id,
          ready: !!m.installed,
          cloneOnly: !!m.cloneOnly,
          voices,
          defaultVoiceId: m.cloneOnly ? voices[0]?.id : m.defaultVoiceId,
        });
      }
    } catch (e) {
      console.error('load tts models failed:', e);
    }
    try {
      const providers = (await window.ipc.invoke('getTtsProviders')) ?? [];
      for (const p of providers) {
        const voices: Array<{ id: string; label: string; lang?: 'zh' | 'en' }> =
          String(p.voices ?? '')
            .split(/[,，、;；\n]/)
            .map((s: string) => s.trim())
            .filter(Boolean)
            .map((v: string) => ({
              id: v,
              // voice_id 不可读的服务商（ElevenLabs）按名称映射展示。
              label: resolveTtsVoiceLabel(p, v),
            }));
        // 绑定该实例且训练就绪的克隆音色（S_ 槽位）追加进音色池。
        for (const cv of clonedVoices) {
          if (
            cv.engine === 'volcengine' &&
            cv.providerId === p.id &&
            cv.trainStatus === 'ready' &&
            cv.speakerId
          ) {
            voices.push({
              id: cv.speakerId,
              label: cv.name,
              lang: cv.language,
            });
          }
        }
        opts.push({
          key: `cloud:${p.id}`,
          kind: 'cloud',
          label: p.name,
          // 必填字段全就绪才可选（半配置的品牌型实例不得进下拉）。
          ready: isTtsProviderConfigured(p),
          unstable: getTtsProviderType(p.type)?.unstable,
          providerType: p.type,
          voices,
          defaultVoiceId: voices[0]?.id,
        });
      }
    } catch (e) {
      console.error('load tts providers failed:', e);
    }
    setEngineOptions(opts);
  }, []);

  useEffect(() => {
    refreshEngines();
  }, [refreshEngines]);

  // ── 配置（记忆恢复）──────────────────────────────────────────────────────
  const [persisted, setPersisted] =
    useLocalStorageState<PersistedDubbingConfig>(
      'dubbingConfig',
      DEFAULT_PERSISTED,
    );
  const updateConfig = useCallback(
    (updates: Partial<PersistedDubbingConfig>) => {
      setPersisted((prev: PersistedDubbingConfig) => ({ ...prev, ...updates }));
    },
    [setPersisted],
  );

  // 生效引擎：记忆项失效（模型被删/实例被删）时回落首个就绪项。
  const activeEngine = useMemo(() => {
    const ready = engineOptions.filter((o) => o.ready);
    return (
      engineOptions.find((o) => o.key === persisted.engineKey && o.ready) ??
      ready[0] ??
      null
    );
  }, [engineOptions, persisted.engineKey]);

  const activeVoice = useMemo(() => {
    if (!activeEngine) return '';
    return (
      activeEngine.voices.find((v) => v.id === persisted.voice)?.id ??
      activeEngine.defaultVoiceId ??
      activeEngine.voices[0]?.id ??
      ''
    );
  }, [activeEngine, persisted.voice]);

  /** 选中音色的语言（仅克隆音色携带；内置音色 undefined）。 */
  const activeVoiceLang = useMemo(
    () => activeEngine?.voices.find((v) => v.id === activeVoice)?.lang,
    [activeEngine, activeVoice],
  );

  /** 字幕主导语言（跨语言克隆提示用；前 50 行文本采样）。 */
  const subtitleLanguage = useMemo(() => {
    if (cues.length === 0) return undefined;
    const sample = cues
      .slice(0, 50)
      .map((c) => c.text)
      .join(' ');
    return sample.trim() ? dominantTextLanguage(sample) : undefined;
  }, [cues]);

  // 媒体是纯音频（导入音频 / 音频任务跳转）：无视频流,视频类输出形态不可用。
  const mediaIsAudio = useMemo(
    () => Boolean(videoPath && isAudioPath(videoPath)),
    [videoPath],
  );

  const buildConfig = useCallback((): DubbingConfig | null => {
    if (!activeEngine || !activeVoice) return null;
    const engine = parseEngineKey(activeEngine.key);
    if (!engine) return null;
    return {
      engine,
      voice: activeVoice,
      globalSpeed: persisted.globalSpeed,
      background: persisted.background,
      output: videoPath && !mediaIsAudio ? persisted.output : 'audioOnly',
      audioFormat: persisted.audioFormat,
      overflow: persisted.overflow,
      overlapMode: persisted.overlapMode ?? 'shift',
      exportShiftedSubtitle: persisted.exportShiftedSubtitle,
    };
  }, [activeEngine, activeVoice, persisted, videoPath, mediaIsAudio]);

  // ── 进度与阶段 ────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [percent, setPercent] = useState(0);
  const [isCancelling, setIsCancelling] = useState(false);
  const [batchSummary, setBatchSummary] = useState<DubbingBatchView | null>(
    null,
  );
  const [exportResult, setExportResult] = useState<DubbingExportView | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = session?.sessionId ?? null;

  useEffect(() => {
    const cleanup = window.ipc?.on(
      'dubbing:progress',
      (payload: DubbingProgressPayload) => {
        if (payload.taskId !== sessionIdRef.current) return;
        setPercent(payload.percent);
        if (payload.cue) {
          const cue = payload.cue;
          setCues((prev) => prev.map((c) => (c.index === cue.index ? cue : c)));
        }
      },
    );
    return () => cleanup?.();
  }, []);

  // ── 会话生命周期 ──────────────────────────────────────────────────────────
  const loadSession = useCallback(
    async (nextSubtitle: string, nextVideo: string | null) => {
      setLoading(true);
      setLoadError(null);
      setBatchSummary(null);
      setExportResult(null);
      setPercent(0);
      const staleId = sessionIdRef.current;
      if (staleId) {
        window.ipc.invoke('dubbing:disposeSession', { sessionId: staleId });
      }
      try {
        const result = await window.ipc.invoke('dubbing:loadSubtitle', {
          subtitlePath: nextSubtitle,
          videoPath: nextVideo || undefined,
        });
        if (!result.success) {
          setSession(null);
          setCues([]);
          setLoadError(result.error || 'load failed');
          return;
        }
        const view = result.data as DubbingSessionView;
        setSession(view);
        setCues(view.cues);
      } catch (e) {
        setSession(null);
        setCues([]);
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 字幕/视频路径变化 → 重建会话（含 query 预填首载）。
  useEffect(() => {
    if (subtitlePath) {
      loadSession(subtitlePath, videoPath);
    } else {
      const staleId = sessionIdRef.current;
      if (staleId) {
        window.ipc.invoke('dubbing:disposeSession', { sessionId: staleId });
      }
      setSession(null);
      setCues([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitlePath, videoPath]);

  // 卸载时释放会话。
  useEffect(() => {
    return () => {
      const staleId = sessionIdRef.current;
      if (staleId) {
        window.ipc.invoke('dubbing:disposeSession', { sessionId: staleId });
      }
    };
  }, []);

  const pickSubtitle = useCallback(async () => {
    const r = await window.ipc.invoke('dubbing:pickFile', { kind: 'subtitle' });
    if (r.success && r.data) setSubtitlePath(r.data);
  }, []);

  const pickVideo = useCallback(async () => {
    const r = await window.ipc.invoke('dubbing:pickFile', { kind: 'video' });
    if (r.success && r.data) setVideoPath(r.data);
  }, []);

  const clearVideo = useCallback(() => setVideoPath(null), []);
  const clearSubtitle = useCallback(() => {
    setSubtitlePath(null);
    setVideoPath(null);
  }, []);

  // ── 批量合成 ──────────────────────────────────────────────────────────────
  const start = useCallback(
    async (opts?: { force?: boolean }) => {
      const config = buildConfig();
      if (!session || !config || running) return;
      setRunning(true);
      setActionError(null);
      setBatchSummary(null);
      setExportResult(null);
      setPercent(0);
      if (opts?.force) {
        // 全量重跑：行状态即刻复位，进度从 0 可视。
        setCues((prev) =>
          prev.map((c) => ({ ...c, status: 'pending' as const })),
        );
      }
      try {
        const result = await window.ipc.invoke('dubbing:start', {
          sessionId: session.sessionId,
          config,
          force: opts?.force,
        });
        if (result.success && result.data) {
          const batch = result.data as DubbingBatchView;
          setCues(batch.cues);
          setBatchSummary(batch);
        } else if (!result.success) {
          setActionError(result.error || 'synthesis failed');
        }
      } finally {
        setRunning(false);
        setIsCancelling(false);
      }
    },
    [session, buildConfig, running],
  );

  const cancel = useCallback(async () => {
    if (!session || isCancelling) return;
    setIsCancelling(true);
    await window.ipc.invoke('dubbing:cancel', { sessionId: session.sessionId });
  }, [session, isCancelling]);

  // ── 行级操作 ──────────────────────────────────────────────────────────────
  const applyCue = useCallback((cue: DubbingCueView) => {
    setCues((prev) => prev.map((c) => (c.index === cue.index ? cue : c)));
  }, []);

  const resynthesizeCue = useCallback(
    async (index: number, overrides?: { text?: string; voiceId?: string }) => {
      const config = buildConfig();
      if (!session || !config) return;
      setActionError(null);
      // 本地即时反馈：行状态转合成中。
      setCues((prev) =>
        prev.map((c) =>
          c.index === index ? { ...c, status: 'synthesizing' } : c,
        ),
      );
      const result = await window.ipc.invoke('dubbing:resynthesizeCue', {
        sessionId: session.sessionId,
        index,
        text: overrides?.text,
        voiceId: overrides?.voiceId,
        config,
      });
      if (result.success && result.data) {
        applyCue(result.data as DubbingCueView);
      } else if (!result.success) {
        setActionError(result.error || 'resynthesize failed');
        setCues((prev) =>
          prev.map((c) =>
            c.index === index
              ? { ...c, status: 'failed', error: result.error }
              : c,
          ),
        );
      }
    },
    [session, buildConfig, applyCue],
  );

  const acceptOverlong = useCallback(
    async (index: number) => {
      if (!session) return;
      const result = await window.ipc.invoke('dubbing:acceptOverlong', {
        sessionId: session.sessionId,
        index,
      });
      if (result.success && result.data)
        applyCue(result.data as DubbingCueView);
      else if (!result.success) setActionError(result.error || 'accept failed');
    },
    [session, applyCue],
  );

  // 行级 voice 覆盖：已合成的行立即重合成;pending 行仅记录,批量时生效。
  const setCueVoice = useCallback(
    async (index: number, voiceId: string) => {
      const cue = cues.find((c) => c.index === index);
      if (!cue || !session) return;
      if (
        cue.status === 'done' ||
        cue.status === 'overlong' ||
        cue.status === 'accepted'
      ) {
        await resynthesizeCue(index, { voiceId });
      } else {
        applyCue({ ...cue, voiceId: voiceId || undefined });
        window.ipc.invoke('dubbing:setCueVoice', {
          sessionId: session.sessionId,
          index,
          voiceId,
        });
      }
    },
    [cues, resynthesizeCue, applyCue, session],
  );

  // ── 播放（行级回放 / 试听 / 顺序播放全部）────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const playAllRef = useRef(false);
  const [playingAll, setPlayingAll] = useState(false);

  const stopAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingKey(null);
  }, []);

  const stopPlayAll = useCallback(() => {
    playAllRef.current = false;
    setPlayingAll(false);
    stopAudio();
  }, [stopAudio]);

  const playWav = useCallback(
    (wavPath: string, key: string) => {
      // 单点播放打断「播放全部」队列。
      playAllRef.current = false;
      setPlayingAll(false);
      stopAudio();
      const audio = new Audio(mediaUrl(wavPath));
      audioRef.current = audio;
      setPlayingKey(key);
      audio.onended = () => setPlayingKey(null);
      audio.onerror = () => setPlayingKey(null);
      audio.play().catch(() => setPlayingKey(null));
    },
    [stopAudio],
  );

  /** 顺序播放所有已合成行（再点一次停止）。 */
  const playAll = useCallback(async () => {
    if (playAllRef.current) {
      stopPlayAll();
      return;
    }
    const playable = [...cues]
      .filter((c) => c.wavPath)
      .sort((a, b) => a.index - b.index);
    if (playable.length === 0) return;
    playAllRef.current = true;
    setPlayingAll(true);
    for (const cue of playable) {
      if (!playAllRef.current) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        audioRef.current?.pause();
        const audio = new Audio(mediaUrl(cue.wavPath!));
        audioRef.current = audio;
        setPlayingKey(`cue-${cue.index}`);
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        // 被 stopAudio/playWav 暂停（打断）时也放行，循环随后按标志位退出。
        audio.onpause = () => resolve();
        audio.play().catch(() => resolve());
      });
    }
    playAllRef.current = false;
    setPlayingAll(false);
    setPlayingKey(null);
  }, [cues, stopPlayAll]);

  const playCue = useCallback(
    async (index: number) => {
      if (playingKey === `cue-${index}`) {
        stopAudio();
        return;
      }
      if (!session) return;
      const result = await window.ipc.invoke('dubbing:cueAudio', {
        sessionId: session.sessionId,
        index,
      });
      if (result.success && result.data) playWav(result.data, `cue-${index}`);
    },
    [session, playWav, playingKey, stopAudio],
  );

  const [previewing, setPreviewing] = useState(false);
  const previewVoice = useCallback(
    async (voiceId?: string, text?: string) => {
      const config = buildConfig();
      if (!config || previewing) return;
      setPreviewing(true);
      setActionError(null);
      try {
        const result = await window.ipc.invoke('dubbing:previewVoice', {
          engine: config.engine,
          voiceId: voiceId || config.voice,
          text,
        });
        if (result.success && result.data) playWav(result.data, 'preview');
        else if (!result.success)
          setActionError(result.error || 'preview failed');
      } finally {
        setPreviewing(false);
      }
    },
    [buildConfig, playWav, previewing],
  );

  // ── 导出 ──────────────────────────────────────────────────────────────────
  const exportDubbing = useCallback(async () => {
    const config = buildConfig();
    if (!session || !config || exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      const result = await window.ipc.invoke('dubbing:export', {
        sessionId: session.sessionId,
        config,
      });
      if (result.success && result.data) {
        setExportResult(result.data as DubbingExportView);
      } else if (!result.success) {
        setActionError(result.error || 'export failed');
      }
    } finally {
      setExporting(false);
    }
  }, [session, buildConfig, exporting]);

  const openOutputFolder = useCallback(async () => {
    if (!exportResult?.outputPath) return;
    await window.ipc.invoke('subtitleMerge:openOutputFolder', {
      filePath: exportResult.outputPath,
    });
  }, [exportResult]);

  // ── 汇总视图 ──────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const overlong = cues.filter((c) => c.status === 'overlong').length;
    const failed = cues.filter((c) => c.status === 'failed').length;
    const done = cues.filter(
      (c) => c.status === 'done' || c.status === 'accepted',
    ).length;
    const overlap = cues.filter((c) => c.overlap).length;
    return { total: cues.length, done, overlong, failed, overlap };
  }, [cues]);

  // 合成字符量预估：待合成（非完成/非已确认）与全量两种口径，跳过纯空白行。
  // 展示口径为正文字符数（含内部空格，贴近各商计费）；Azure SSML 附加、
  // ElevenLabs 字节膨胀等差异由 UI 文案声明，不在数值内折算。
  const charEstimate = useMemo(() => {
    let pendingRows = 0;
    let pendingChars = 0;
    let totalRows = 0;
    let totalChars = 0;
    for (const c of cues) {
      const len = c.text.trim().length;
      if (len === 0) continue;
      totalRows += 1;
      totalChars += len;
      if (c.status !== 'done' && c.status !== 'accepted') {
        pendingRows += 1;
        pendingChars += len;
      }
    }
    return { pendingRows, pendingChars, totalRows, totalChars };
  }, [cues]);

  const phase: DubbingUiPhase = !session
    ? 'idle'
    : running
      ? 'synthesizing'
      : exporting
        ? 'exporting'
        : summary.done > 0
          ? 'done'
          : 'ready';

  const canStart = Boolean(
    session && activeEngine && activeVoice && !running && !exporting,
  );
  const canExport = Boolean(
    session && summary.done + summary.overlong > 0 && !running && !exporting,
  );

  return {
    // 文件
    subtitlePath,
    videoPath,
    mediaIsAudio,
    setSubtitlePath,
    setVideoPath,
    pickSubtitle,
    pickVideo,
    clearVideo,
    clearSubtitle,
    // 会话
    session,
    cues,
    loading,
    loadError,
    // 引擎与配置
    engineOptions,
    activeEngine,
    activeVoice,
    activeVoiceLang,
    subtitleLanguage,
    config: persisted,
    updateConfig,
    refreshEngines,
    // 批量
    start,
    cancel,
    running,
    exporting,
    isCancelling,
    percent,
    batchSummary,
    actionError,
    // 行级
    resynthesizeCue,
    acceptOverlong,
    setCueVoice,
    playCue,
    previewVoice,
    previewing,
    playingKey,
    stopAudio,
    playAll,
    playingAll,
    // 导出
    exportDubbing,
    exportResult,
    openOutputFolder,
    // 汇总
    summary,
    charEstimate,
    phase,
    canStart,
    canExport,
  };
}

export type UseDubbingReturn = ReturnType<typeof useDubbing>;

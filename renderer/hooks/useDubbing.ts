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
  DubbingCloneQuality,
  DubbingOutputMode,
  DubbingAudioFormat,
  DubbingOverflowMode,
  DubbingOverlapMode,
} from '../../types/dubbing';
import { dominantTextLanguage } from '../../types/voiceClone';
import {
  loadTtsEngineOptions,
  parseEngineKey,
  type DubbingEngineOption,
} from './useTtsEngineOptions';

export type { DubbingEngineOption } from './useTtsEngineOptions';

/** 可持久化的工作台配置（localStorage 记忆，下次进入恢复）。 */
interface PersistedDubbingConfig {
  engineKey: string;
  voice: string;
  globalSpeed: number;
  cloneQuality?: DubbingCloneQuality;
  localConcurrency?: number;
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
  cloneQuality: 'standard',
  localConcurrency: 1,
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

export function useDubbing(options?: {
  initialSubtitlePath?: string;
  initialVideoPath?: string;
  /** 最近任务回开：尝试恢复的持久化会话 */
  initialSessionId?: string;
  /** 关联的工作项（恢复/重建保持同一条最近任务记录） */
  workItemId?: string;
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
  // 会话恢复：一次性消费的初始 sessionId（仅首载尝试恢复）
  const restoreSessionIdRef = useRef<string | null>(
    options?.initialSessionId || null,
  );
  // 纯会话恢复成功后回填文件状态时，挡住加载 effect 的重入
  const syncFromRestoreRef = useRef(false);
  // 用户确认重建后一次性消费的旧会话 id（loadSession 内取用，避免双载竞态）
  const rebuildSessionIdRef = useRef<string | null>(null);
  const workItemIdRef = useRef<string | null>(options?.workItemId || null);
  /** 恢复成功提示（行级进度已回填） */
  const [restoredFromSession, setRestoredFromSession] = useState(false);
  /** 字幕已变，等待用户确认重建（保留旧产物直至确认） */
  const [staleRestore, setStaleRestore] = useState<{
    sessionId: string;
    subtitlePath: string;
    videoPath?: string;
  } | null>(null);

  // ── 引擎候选（加载逻辑与新建任务向导共用）────────────────────────────────
  const [engineOptions, setEngineOptions] = useState<DubbingEngineOption[]>([]);

  const refreshEngines = useCallback(async () => {
    setEngineOptions(await loadTtsEngineOptions());
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
      cloneQuality: persisted.cloneQuality ?? 'standard',
      localConcurrency: persisted.localConcurrency ?? 1,
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
  // 卸载清理时判断批量/导出是否进行中（进行中则后台继续，不中断）
  const runningRef = useRef(false);
  runningRef.current = running;
  const exportingRef = useRef(false);
  exportingRef.current = exporting;

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
        // 批量终态事件：重连场景（发起批量的页面已卸载）靠它退出运行态
        if (payload.stage === 'done') {
          setRunning(false);
          setIsCancelling(false);
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
      setRestoredFromSession(false);
      setStaleRestore(null);
      const staleId = sessionIdRef.current;
      if (staleId) {
        window.ipc.invoke('dubbing:disposeSession', { sessionId: staleId });
      }
      // 恢复/重建都是一次性消费：仅本次 load 携带
      const restoreId = restoreSessionIdRef.current;
      restoreSessionIdRef.current = null;
      const rebuildId = rebuildSessionIdRef.current;
      rebuildSessionIdRef.current = null;
      try {
        const result = await window.ipc.invoke('dubbing:loadSubtitle', {
          subtitlePath: nextSubtitle,
          videoPath: nextVideo || undefined,
          sessionId: restoreId || undefined,
          rebuildSessionId: rebuildId || undefined,
          workItemId: workItemIdRef.current || undefined,
        });
        if (!result.success) {
          setSession(null);
          setCues([]);
          setLoadError(result.error || 'load failed');
          return;
        }
        const data = result.data as
          | (DubbingSessionView & { restored?: boolean })
          | { stale: true; subtitlePath: string; videoPath?: string };
        if ('stale' in data && data.stale) {
          // 字幕已变：不静默重建，弹确认（确认后携 rebuildSessionId 重载）
          setSession(null);
          setCues([]);
          setStaleRestore({
            sessionId: restoreId!,
            subtitlePath: data.subtitlePath,
            videoPath: data.videoPath,
          });
          return;
        }
        const view = data as DubbingSessionView & { restored?: boolean };
        setSession(view);
        setCues(view.cues);
        if (view.restored) setRestoredFromSession(true);
        // 批量在后台进行中（页面离开后回连）：恢复运行态，进度事件自动续接
        if (view.running) setRunning(true);
        // 仅凭会话 id 恢复（检查员模式/回开未携字幕路径）：把元数据里的
        // 文件路径回填到状态供文件条/播放器展示；ref 挡住 effect 的重复加载
        if (!nextSubtitle && view.subtitlePath) {
          syncFromRestoreRef.current = true;
          setSubtitlePath(view.subtitlePath);
          setVideoPath(view.videoPath ?? null);
        }
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

  /** 字幕已变 → 用户确认重建：删除旧会话数据后按当前字幕新建 */
  const confirmRebuild = useCallback(() => {
    if (!staleRestore) return;
    const { sessionId, subtitlePath: sub, videoPath: vid } = staleRestore;
    setStaleRestore(null);
    rebuildSessionIdRef.current = sessionId;
    setSubtitlePath(sub);
    setVideoPath(vid || null);
    loadSession(sub, vid || null);
  }, [staleRestore, loadSession]);

  /** 放弃重建：回到空态（旧会话数据保留） */
  const cancelRebuild = useCallback(() => {
    setStaleRestore(null);
    setSubtitlePath(null);
    setVideoPath(null);
  }, []);

  // 字幕/视频路径变化 → 重建会话（含 query 预填首载）。
  // 仅携 session id 打开（检查员模式跳转）时走纯恢复：字幕路径在会话元数据里，
  // 恢复成功后回填状态（syncFromRestoreRef 挡住由回填触发的本 effect 重入）。
  useEffect(() => {
    if (syncFromRestoreRef.current) {
      syncFromRestoreRef.current = false;
      return;
    }
    if (subtitlePath) {
      loadSession(subtitlePath, videoPath);
    } else if (restoreSessionIdRef.current) {
      loadSession('', null);
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

  // 卸载时释放会话：批量进行中则后台继续（keepRunning），
  // 经最近任务回开可实时重连；空闲会话正常释放内存态。
  useEffect(() => {
    return () => {
      const staleId = sessionIdRef.current;
      if (staleId) {
        window.ipc.invoke('dubbing:disposeSession', {
          sessionId: staleId,
          keepRunning: runningRef.current || exportingRef.current,
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          cloneQuality: config.cloneQuality,
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
  // 返回导出结果视图（失败/中断返回 null），调用方据此做成功通知。
  const exportDubbing =
    useCallback(async (): Promise<DubbingExportView | null> => {
      const config = buildConfig();
      if (!session || !config || exporting) return null;
      setExporting(true);
      setActionError(null);
      try {
        const result = await window.ipc.invoke('dubbing:export', {
          sessionId: session.sessionId,
          config,
        });
        if (result.success && result.data) {
          const view = result.data as DubbingExportView;
          setExportResult(view);
          return view;
        }
        if (!result.success) {
          setActionError(result.error || 'export failed');
        }
        return null;
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
    restoredFromSession,
    staleRestore,
    confirmRebuild,
    cancelRebuild,
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

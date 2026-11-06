/**
 * 配音工作台单一状态 hook（subtitleMerge 范式）：
 * 文件/引擎/配置/行状态/进度/导出全收敛于此，组件只渲染。
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigationGuard } from '../context/NavigationGuardContext';
import { useVoicePreview } from './useVoicePreview';
import { useDubbingCueDrafts } from './useDubbingCueDrafts';
import { isAudioPath } from 'lib/utils';
import { isProviderConfigured } from 'lib/providerUtils';
import { useTranslation } from 'next-i18next';
import type { Provider } from '../../main/translate/types';
import { aiPrompt } from '../lib/inlineAi';
import { invokeDubbingOperation } from '../lib/dubbingOperation';
import {
  DEFAULT_DUBBING_PREFERENCES as DEFAULT_PERSISTED,
  parseDubbingPreferences,
  dubbingConfigDraftKey,
  parseDubbingConfigDraft,
  writeDubbingConfigDraft,
  type PersistedDubbingConfig,
  type DubbingConfigDraft,
} from '../lib/dubbingConfigDraft';
import { stripSpeakerLabelPrefix } from '../../main/helpers/speakerDiarization/alignment';
import type {
  DubbingConfig,
  DubbingCueView,
  DubbingSessionView,
  DubbingProgressPayload,
  DubbingBatchView,
  DubbingExportView,
  DubbingEngineSelection,
  DubbingSpeaker,
  DubbingSpeakerVoiceMap,
  DubbingSpeakerSettings,
} from '../../types/dubbing';
import {
  missingDubbingSpeakerVoiceIds,
  primaryDubbingSpeakerId,
  resolveDubbingVoiceId,
} from '../../types/dubbing';
import {
  resolveTtsLanguage,
  localTtsLanguageError,
} from '../../types/ttsLanguage';
import {
  loadTtsEngineOptions,
  parseEngineKey,
  type DubbingEngineOption,
} from './useTtsEngineOptions';

export type { DubbingEngineOption } from './useTtsEngineOptions';

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
  initialProofreadDataFile?: string;
  /** 关联的工作项（恢复/重建保持同一条最近任务记录） */
  workItemId?: string;
}) {
  const { t } = useTranslation('dubbing');
  const [aiProviders, setAiProviders] = useState<Provider[]>([]);
  const [aiProviderId, setAiProviderId] = useState('');
  const [shorteningIndex, setShorteningIndex] = useState<number | null>(null);
  const shortenRequest = useRef<{ id: string; cancel: () => void } | null>(
    null,
  );
  const cancelShortening = useCallback(() => {
    const request = shortenRequest.current;
    if (!request) return;
    shortenRequest.current = null;
    request.cancel();
    void window.ipc
      .invoke('cancelProofreadBatch', { batchId: request.id })
      .catch(() => {});
  }, []);
  const reloadAiProviders = useCallback(async () => {
    const result = await window.ipc.invoke('getAiTranslationProviders');
    if (result?.success && Array.isArray(result.data)) {
      const available = result.data.filter(isProviderConfigured);
      setAiProviders(available);
      setAiProviderId((previous) =>
        available.some((p: Provider) => p.id === previous)
          ? previous
          : available[0]?.id || '',
      );
    }
  }, []);
  useEffect(() => {
    void reloadAiProviders().catch(() => {});
    return cancelShortening;
  }, [reloadAiProviders, cancelShortening]);
  // ── 文件与会话 ────────────────────────────────────────────────────────────
  const [subtitlePath, setSubtitleState] = useState<string | null>(
    options?.initialSubtitlePath || null,
  );
  const subtitleInputRef = useRef(subtitlePath);
  subtitleInputRef.current = subtitlePath;
  const [videoPath, setVideoState] = useState<string | null>(
    options?.initialVideoPath || null,
  );
  const [session, setSession] = useState<DubbingSessionView | null>(null);
  const [cues, setCues] = useState<DubbingCueView[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lockedSessionId, setLockedSessionId] = useState<string | null>(null);
  const lockedSessionRef = useRef<string | null>(null);
  const ownedSessionRef = useRef<{ sessionId: string; leaseId: string } | null>(
    null,
  );
  const releaseLease = (lease: { sessionId?: string; leaseId: string }) => {
    void window.ipc
      .invoke('dubbing:disposeSession', { ...lease, keepRunning: true })
      .catch(() => {});
  };
  const ownsLease = (leaseId: string | undefined) =>
    !!leaseId &&
    mountedRef.current &&
    ownedSessionRef.current?.leaseId === leaseId;
  const mountedRef = useRef(false);
  const loadRevisionRef = useRef(0);
  const loadPendingRef = useRef<{
    subtitle: string;
    video: string | null;
    restoreId: string | null;
    leaseId: string;
    promise: Promise<any>;
  } | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRevisionRef.current++;
    };
  }, []);
  // 会话恢复：一次性消费的初始 sessionId（仅首载尝试恢复）
  const restoreSessionIdRef = useRef<string | null>(
    options?.initialSessionId || null,
  );
  // 纯会话恢复成功后回填文件状态时，挡住加载 effect 的重入
  const syncFromRestoreRef = useRef(false);
  // 用户确认重建后一次性消费的旧会话 id（loadSession 内取用，避免双载竞态）
  const rebuildSessionIdRef = useRef<string | null>(null);
  const workItemIdRef = useRef<string | null>(options?.workItemId || null);
  const proofreadDataFileRef = useRef<string | null>(
    options?.initialProofreadDataFile || null,
  );
  const setSubtitlePath = useCallback(
    (next: string | null) => {
      if (
        lockedSessionRef.current ||
        configRecoveryRef.current ||
        configDiscardingRef.current ||
        configDirtyRef.current ||
        configSavePromise.current ||
        cueDrafts.blocked()
      )
        return;
      if (next !== subtitlePath) {
        subtitleInputRef.current = next;
        workItemIdRef.current = null;
        proofreadDataFileRef.current = null;
        setSubtitleState(next);
      }
    },
    [subtitlePath],
  );
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
  const [persisted, setPersistedState] = useState(DEFAULT_PERSISTED);
  const persistedRef = useRef(persisted);
  const savedPreferences = useRef(persisted);
  const configDirtyRef = useRef(false);
  const configReadFailed = useRef(false);
  const configReadyRef = useRef(false);
  const savedConfigKey = useRef('');
  const configSavePromise = useRef<Promise<boolean> | null>(null);
  const configDiscardingRef = useRef(false);
  const [configReady, setConfigReady] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [configRecovery, setConfigRecovery] = useState<
    DubbingConfigDraft | 'unreadable' | null
  >(null);
  const configRecoveryRef = useRef<DubbingConfigDraft | 'unreadable' | null>(
    null,
  );
  const configJournalRef = useRef<{
    sessionId: string;
    leaseId: string;
    raw: string | null;
    readable: boolean;
    durableRaw: string | null;
    durableReadable: boolean;
    revision: number;
    queue: Promise<unknown>;
    uncertain?: { raw: string | null };
  } | null>(null);
  const journalIntentRef = useRef(false);
  const setRecovery = (value: DubbingConfigDraft | 'unreadable' | null) => {
    configRecoveryRef.current = value;
    setConfigRecovery(value);
  };
  const writeDurableIntent = (
    journal: NonNullable<typeof configJournalRef.current>,
    raw: string | null,
  ) => {
    const operation = journal.queue
      .catch(() => {})
      .then(async () => {
        if (!ownsLease(journal.leaseId))
          throw new Error('Dubbing editor lease has changed');
        if (!journal.durableReadable)
          throw new Error('Dubbing recovery journal has not been read');
        if (journal.uncertain) {
          const check = await window.ipc.invoke('dubbing:readConfigDraft', {
            sessionId: journal.sessionId,
            leaseId: journal.leaseId,
          });
          if (!check?.success)
            throw new Error(
              check?.error || 'Dubbing recovery journal read failed',
            );
          if (check.data === journal.uncertain.raw)
            journal.durableRaw = check.data;
          else if (check.data !== journal.durableRaw)
            throw new Error(
              'Dubbing configuration draft changed in another editor',
            );
          journal.uncertain = undefined;
        }
        try {
          journal.uncertain = { raw };
          const result = await window.ipc.invoke('dubbing:writeConfigDraft', {
            sessionId: journal.sessionId,
            leaseId: journal.leaseId,
            expected: journal.durableRaw,
            raw,
          });
          if (!result?.success || result.data !== raw)
            throw new Error(
              result?.error || 'Dubbing recovery journal write failed',
            );
          journal.durableRaw = raw;
          journal.uncertain = undefined;
        } catch (error) {
          // A lost acknowledgement must not strand the next compare-and-swap.
          const check = await window.ipc
            .invoke('dubbing:readConfigDraft', {
              sessionId: journal.sessionId,
              leaseId: journal.leaseId,
            })
            .catch(() => null);
          if (check?.success && check.data === raw) {
            journal.durableRaw = raw;
            journal.uncertain = undefined;
          } else throw error;
        }
      });
    journal.queue = operation;
    return operation;
  };
  const persistConfigIntent = async (current: PersistedDubbingConfig) => {
    const journal = configJournalRef.current;
    if (!journal || !journalIntentRef.current) return;
    if (!journal.readable)
      throw new Error('Dubbing configuration draft has not been read');
    const draft: DubbingConfigDraft = {
      version: 1,
      revision: journal.revision,
      sessionId: journal.sessionId,
      saved: savedPreferences.current,
      current,
    };
    const durable = writeDurableIntent(journal, JSON.stringify(draft));
    try {
      journal.raw = writeDubbingConfigDraft(
        journal.sessionId,
        journal.raw,
        draft,
      );
    } catch (error) {
      await durable;
      throw error;
    }
    await durable;
  };
  const clearConfigIntent = async () => {
    const journal = configJournalRef.current;
    const revision = journal?.revision;
    if (journal && journalIntentRef.current) {
      await writeDurableIntent(journal, null);
      if (journal !== configJournalRef.current || revision !== journal.revision)
        return false;
      journal.raw = writeDubbingConfigDraft(
        journal.sessionId,
        journal.raw,
        null,
      );
    }
    journalIntentRef.current = false;
    return true;
  };
  const inspectConfigDraft = async (sessionId: string) => {
    const leaseId = ownedSessionRef.current?.leaseId;
    if (!leaseId) return false;
    const journal = {
      sessionId,
      leaseId,
      raw: null as string | null,
      readable: false,
      durableRaw: null as string | null,
      durableReadable: false,
      revision: 0,
      queue: Promise.resolve() as Promise<unknown>,
    };
    configJournalRef.current = journal;
    setRecovery('unreadable');
    try {
      const result = await window.ipc.invoke('dubbing:readConfigDraft', {
        sessionId,
        leaseId,
      });
      if (!ownsLease(leaseId)) return false;
      if (
        !result?.success ||
        !(result.data === null || typeof result.data === 'string')
      )
        throw new Error(
          result?.error || 'Dubbing recovery journal read failed',
        );
      journal.durableRaw = result.data;
      journal.durableReadable = true;
      journal.raw = localStorage.getItem(dubbingConfigDraftKey(sessionId));
      journal.readable = true;
      const local = journal.raw
        ? parseDubbingConfigDraft(journal.raw, sessionId)
        : null;
      const disk = journal.durableRaw
        ? parseDubbingConfigDraft(journal.durableRaw, sessionId)
        : null;
      const selected =
        local && (!disk || local.revision > disk.revision) ? local : disk;
      journal.revision = selected?.revision || 0;
      setRecovery(selected);
      setConfigError(null);
      return true;
    } catch (error) {
      if (!ownsLease(leaseId)) return false;
      setRecovery('unreadable');
      setConfigError(String(error));
      return false;
    }
  };
  const setPersisted = useCallback(
    (change: (previous: PersistedDubbingConfig) => PersistedDubbingConfig) => {
      const next = change(persistedRef.current);
      persistedRef.current = next;
      setPersistedState(next);
    },
    [],
  );
  const readPreferences = useCallback(() => {
    try {
      const raw = localStorage.getItem('dubbingConfig');
      const value = raw ? JSON.parse(raw) : {};
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid dubbing preferences');
      const next = parseDubbingPreferences({ ...DEFAULT_PERSISTED, ...value });
      setPersisted(() => next);
      savedPreferences.current = next;
      configReadFailed.current = false;
      configReadyRef.current = true;
      setConfigReady(true);
      setConfigError(null);
      return true;
    } catch (error) {
      configReadFailed.current = true;
      configDirtyRef.current = true;
      setConfigDirty(true);
      setConfigError(String(error));
      return false;
    }
  }, [setPersisted]);
  useEffect(() => {
    readPreferences();
  }, [readPreferences]);
  const configBlockedRef = useRef<(ignoreCueDrafts?: boolean) => boolean>(
    () => false,
  );
  const updateConfig = useCallback(
    (updates: Partial<PersistedDubbingConfig>) => {
      if (
        !configReadyRef.current ||
        !!lockedSessionRef.current ||
        !!configRecoveryRef.current ||
        configDiscardingRef.current ||
        configContext.current.loading ||
        runningRef.current ||
        exportingRef.current
      )
        return false;
      configDirtyRef.current = true;
      setConfigDirty(true);
      setPersisted((prev: PersistedDubbingConfig) => ({ ...prev, ...updates }));
      journalIntentRef.current = true;
      if (configJournalRef.current) configJournalRef.current.revision++;
      void persistConfigIntent(persistedRef.current).catch((error) => {
        if (mountedRef.current) setConfigError(String(error));
      });
      return true;
    },
    [setPersisted],
  );

  // Only a new, unconfigured project may choose a default automatically.
  const activeEngine = useMemo(() => {
    return (
      (persisted.engineKey
        ? engineOptions.find((o) => o.key === persisted.engineKey && o.ready)
        : engineOptions.find((o) => o.ready)) ?? null
    );
  }, [engineOptions, persisted.engineKey]);

  const activeVoice = useMemo(() => {
    if (!activeEngine) return '';
    if (persisted.voice)
      return activeEngine.voices.some((v) => v.id === persisted.voice)
        ? persisted.voice
        : '';
    return activeEngine.defaultVoiceId ?? activeEngine.voices[0]?.id ?? '';
  }, [activeEngine, persisted.voice]);

  /** Voice language is a fallback; subtitle language determines pronunciation. */
  const activeVoiceLang = useMemo(
    () => activeEngine?.voices.find((v) => v.id === activeVoice)?.lang,
    [activeEngine, activeVoice],
  );

  const speakers: DubbingSpeaker[] = session?.speakers || [];
  const speakerVoiceMap: DubbingSpeakerVoiceMap =
    session?.speakerVoiceMap || {};
  const speakerVoiceConflicts = session?.speakerVoiceConflicts || {};
  const speakerSettings = session?.speakerSettings || {};
  const speakerSettingsConflicts = session?.speakerSettingsConflicts || {};
  const [speakerUpdating, setSpeakerUpdating] = useState(false);
  const speakerMutationRef = useRef(false);
  const voiceRevisionRef = useRef(0);
  const availableVoiceIds = useMemo(
    () => new Set((activeEngine?.voices || []).map((voice) => voice.id)),
    [activeEngine],
  );
  const speakerMode =
    speakers.filter((speaker) => speaker.cueCount > 0).length > 1;
  const missingSpeakerVoiceIds = useMemo(
    () =>
      missingDubbingSpeakerVoiceIds(
        speakers,
        speakerVoiceMap,
        availableVoiceIds,
      ),
    [speakers, speakerVoiceMap, availableVoiceIds],
  );
  const conflictingSpeakerIds = useMemo(() => {
    const activeSpeakerIds = new Set(
      speakers
        .filter((speaker) => speaker.cueCount > 0)
        .map((speaker) => speaker.id),
    );
    return Array.from(
      new Set([
        ...Object.keys(speakerVoiceConflicts),
        ...Object.keys(speakerSettingsConflicts),
      ]),
    )
      .filter(
        (id) =>
          activeSpeakerIds.has(Number(id)) &&
          ((speakerVoiceConflicts[id] || []).length > 1 ||
            (speakerSettingsConflicts[id] || []).length > 1),
      )
      .map(Number);
  }, [speakers, speakerVoiceConflicts, speakerSettingsConflicts]);
  const invalidCueOverrideCount = useMemo(
    () =>
      activeEngine
        ? cues.filter(
            (cue) => cue.voiceId && !availableVoiceIds.has(cue.voiceId),
          ).length
        : 0,
    [activeEngine, availableVoiceIds, cues],
  );

  const resolvedVoiceForCue = useCallback(
    (cue: DubbingCueView): string =>
      resolveDubbingVoiceId(cue, speakerVoiceMap, activeVoice),
    [speakerVoiceMap, activeVoice],
  );

  const subtitleLanguage =
    session?.subtitleLanguage ?? session?.detectedLanguage;
  const autoSpeechLanguage = resolveTtsLanguage({
    subtitleLanguage,
    voiceLanguage: activeVoiceLang,
  });
  const speechLanguage = resolveTtsLanguage({
    language: persisted.language,
    subtitleLanguage,
    voiceLanguage: activeVoiceLang,
  });
  const unsupportedLanguage =
    activeEngine?.kind === 'local'
      ? localTtsLanguageError(
          activeEngine.key.slice('local:'.length),
          speechLanguage,
        )
      : undefined;

  // 媒体是纯音频（导入音频 / 音频任务跳转）：无视频流,视频类输出形态不可用。
  const mediaIsAudio = useMemo(
    () => Boolean(videoPath && isAudioPath(videoPath)),
    [videoPath],
  );

  const buildConfig = useCallback((): DubbingConfig | null => {
    const persisted = persistedRef.current;
    const selected = persisted.engineKey
      ? engineOptions.find((o) => o.key === persisted.engineKey)
      : engineOptions.find((o) => o.ready);
    const voice =
      persisted.voice || selected?.defaultVoiceId || selected?.voices[0]?.id;
    if (!voice) return null;
    const engine = parseEngineKey(persisted.engineKey || selected?.key || '');
    if (!engine) return null;
    return {
      engine,
      language: persisted.language || 'auto',
      voice,
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
  }, [engineOptions, persisted, videoPath, mediaIsAudio]);

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
  const batchRequestRef = useRef<{ sessionId: string } | null>(null);
  const exportRequestRef = useRef<{ sessionId: string } | null>(null);
  const cancelRequestRef = useRef<{ sessionId: string } | null>(null);
  const cueDrafts = useDubbingCueDrafts({
    owns: ownsLease,
    busy: () =>
      loading ||
      runningRef.current ||
      exportingRef.current ||
      speakerMutationRef.current ||
      !!configSavePromise.current ||
      configDiscardingRef.current,
    acquire: () => {
      speakerMutationRef.current = true;
      setSpeakerUpdating(true);
    },
    release: () => {
      speakerMutationRef.current = false;
      if (mountedRef.current) setSpeakerUpdating(false);
    },
    apply: (view) => {
      setCues(view.cues);
      setSession((current) =>
        current?.sessionId === view.sessionId
          ? {
              ...current,
              cues: view.cues,
              detectedLanguage: view.detectedLanguage,
            }
          : current,
      );
      setExportResult(null);
    },
  });

  useEffect(() => {
    const cleanup = window.ipc?.on(
      'dubbing:progress',
      (payload: DubbingProgressPayload) => {
        if (
          payload.taskId !== sessionIdRef.current ||
          !ownsLease(payload.leaseId)
        )
          return;
        setPercent(payload.percent);
        if (payload.cue) {
          const cue = payload.cue;
          setCues((prev) => prev.map((c) => (c.index === cue.index ? cue : c)));
        }
        // 批量终态事件：重连场景（发起批量的页面已卸载）靠它退出运行态
        if (
          payload.stage === 'done' &&
          !batchRequestRef.current &&
          !exportRequestRef.current
        ) {
          setRunning(false);
          setIsCancelling(false);
        }
      },
    );
    return () => cleanup?.();
  }, []);

  useEffect(
    () =>
      window.ipc?.on(
        'dubbing:sessionState',
        (payload: {
          session: DubbingSessionView;
          error?: string;
          exportResult?: DubbingExportView;
        }) => {
          const view = payload.session;
          if (
            !view ||
            view.sessionId !== sessionIdRef.current ||
            !ownsLease(view.leaseId) ||
            batchRequestRef.current?.sessionId === view.sessionId ||
            exportRequestRef.current?.sessionId === view.sessionId ||
            speakerMutationRef.current
          )
            return;
          setSession(view);
          setCues(view.cues);
          setVideoState(view.videoPath ?? null);
          setRunning(Boolean(view.running));
          if (!view.running) {
            setExporting(false);
            setIsCancelling(false);
          }
          if (payload.error) setActionError(payload.error);
          if (payload.exportResult) setExportResult(payload.exportResult);
        },
      ),
    [],
  );

  const activeSessionId = session?.sessionId;
  const latestConfig = useRef(buildConfig);
  latestConfig.current = buildConfig;
  useEffect(
    () => cancelShortening,
    [activeSessionId, buildConfig, cancelShortening],
  );
  const configContext = useRef({ loading, running, exporting });
  configContext.current = { loading, running, exporting };
  const configKey = () =>
    JSON.stringify([
      sessionIdRef.current,
      ownedSessionRef.current?.leaseId,
      latestConfig.current(),
    ]);
  configBlockedRef.current = (ignoreCueDrafts = false) =>
    (!ignoreCueDrafts && cueDrafts.blocked()) ||
    !configReadyRef.current ||
    !!lockedSessionRef.current ||
    !!configRecoveryRef.current ||
    configDirtyRef.current ||
    !!configSavePromise.current ||
    configDiscardingRef.current ||
    (Boolean(sessionIdRef.current) &&
      Boolean(latestConfig.current()) &&
      savedConfigKey.current !== configKey());
  const saveConfig = useCallback((): Promise<boolean> => {
    if (configSavePromise.current) return configSavePromise.current;
    if (configReadFailed.current && !readPreferences())
      return Promise.resolve(false);
    const busy = configContext.current;
    if (
      !configReadyRef.current ||
      !!lockedSessionRef.current ||
      !!configRecoveryRef.current ||
      configDiscardingRef.current ||
      busy.loading ||
      busy.running ||
      busy.exporting ||
      speakerMutationRef.current
    )
      return Promise.resolve(false);
    configDirtyRef.current = true;
    setConfigDirty(true);
    setConfigSaving(true);
    setConfigError(null);
    const save = async () => {
      try {
        for (;;) {
          let preferences = persistedRef.current;
          const id = sessionIdRef.current;
          const leaseId = ownedSessionRef.current?.leaseId;
          const config = latestConfig.current();
          if (id && !config) throw new Error(t('configSelectionRequired'));
          if (config) {
            const engineKey =
              config.engine.kind === 'local'
                ? `local:${config.engine.modelId}`
                : `cloud:${config.engine.providerId}`;
            if (
              preferences.engineKey !== engineKey ||
              preferences.voice !== config.voice
            ) {
              preferences = { ...preferences, engineKey, voice: config.voice };
              setPersisted(() => preferences);
            }
          }
          const key = JSON.stringify([id, leaseId, config]);
          await persistConfigIntent(preferences);
          localStorage.setItem('dubbingConfig', JSON.stringify(preferences));
          if (id && config && savedConfigKey.current !== key) {
            const previousKey = savedConfigKey.current;
            savedConfigKey.current = '';
            const result = await window.ipc.invoke('dubbing:syncVoiceState', {
              sessionId: id,
              leaseId,
              config,
            });
            if (result?.success === false) savedConfigKey.current = previousKey;
            if (!result?.success || !Array.isArray(result.data?.cues))
              throw new Error(result?.error || 'Configuration save failed');
            if (!ownsLease(leaseId) || sessionIdRef.current !== id)
              return false;
            setCues(result.data.cues);
            setSession((current) =>
              current?.sessionId === id
                ? {
                    ...current,
                    detectedLanguage: result.data.detectedLanguage,
                    configSnapshot: config,
                  }
                : current,
            );
          }
          if (
            !mountedRef.current ||
            sessionIdRef.current !== id ||
            (id && !ownsLease(leaseId))
          )
            return false;
          savedPreferences.current = preferences;
          savedConfigKey.current = key;
          if (preferences !== persistedRef.current) continue;
          if (
            !(await clearConfigIntent()) ||
            preferences !== persistedRef.current
          )
            continue;
          configDirtyRef.current = false;
          setConfigDirty(false);
          return true;
        }
      } catch (error) {
        if (mountedRef.current) setConfigError(String(error));
        return false;
      } finally {
        configSavePromise.current = null;
        if (mountedRef.current) setConfigSaving(false);
      }
    };
    // Defer execution so synchronous storage errors also clear the same promise.
    configSavePromise.current = Promise.resolve().then(save);
    return configSavePromise.current;
  }, [readPreferences, setPersisted, t]);
  const discardConfig = useCallback(async () => {
    if (configSavePromise.current || configDiscardingRef.current) return false;
    configDiscardingRef.current = true;
    setConfigSaving(true);
    const leaseId = ownedSessionRef.current?.leaseId;
    try {
      const journal = configJournalRef.current;
      if (
        configRecoveryRef.current &&
        journal &&
        (!journal.readable || !journal.durableReadable)
      )
        throw new Error('Retry reading the draft before discarding it');
      localStorage.setItem(
        'dubbingConfig',
        JSON.stringify(savedPreferences.current),
      );
      if (configRecoveryRef.current && journal) {
        if (
          localStorage.getItem(dubbingConfigDraftKey(journal.sessionId)) !==
          journal.raw
        )
          throw new Error(
            'Dubbing configuration draft changed in another editor',
          );
        await writeDurableIntent(journal, null);
        if (!ownsLease(leaseId)) return false;
        journal.raw = writeDubbingConfigDraft(
          journal.sessionId,
          journal.raw,
          null,
        );
        setRecovery(null);
        journalIntentRef.current = false;
      }
      setPersisted(() => savedPreferences.current);
      configReadFailed.current = false;
      configReadyRef.current = true;
      configDirtyRef.current = false;
      setConfigReady(true);
      setConfigDirty(false);
      setConfigError(null);
      if (sessionIdRef.current && savedConfigKey.current !== configKey()) {
        configDirtyRef.current = true;
        setConfigDirty(true);
        configDiscardingRef.current = false;
        return await saveConfig();
      }
      await clearConfigIntent();
      return true;
    } catch (error) {
      configDirtyRef.current = true;
      setConfigDirty(true);
      setConfigError(String(error));
      return false;
    } finally {
      configDiscardingRef.current = false;
      if (mountedRef.current) setConfigSaving(false);
    }
  }, [setPersisted, saveConfig]);
  const restoreConfigDraft = useCallback(() => {
    const draft = configRecoveryRef.current;
    if (
      !draft ||
      draft === 'unreadable' ||
      configDiscardingRef.current ||
      !!configSavePromise.current ||
      configContext.current.running ||
      configContext.current.exporting
    )
      return false;
    setPersisted(() => draft.current);
    setRecovery(null);
    journalIntentRef.current = true;
    configDirtyRef.current = true;
    setConfigDirty(true);
    setConfigError(null);
    return true;
  }, [setPersisted]);
  const retryConfigDraft = useCallback(() => {
    if (configDiscardingRef.current || configSavePromise.current) return false;
    const id = ownedSessionRef.current?.sessionId;
    return id ? inspectConfigDraft(id) : false;
  }, []);
  useNavigationGuard('dubbing-config', {
    isDirty: configDirty || configSaving || !!configRecovery,
    getIsDirty: () =>
      configDirtyRef.current ||
      !!configSavePromise.current ||
      configDiscardingRef.current ||
      !!configRecoveryRef.current,
    onSave: saveConfig,
    onDiscard: discardConfig,
  });
  useEffect(() => {
    if (
      !configReady ||
      loading ||
      running ||
      exporting ||
      speakerUpdating ||
      configRecovery
    )
      return;
    if (!activeSessionId && !configDirtyRef.current) return;
    if (!latestConfig.current() && !configDirtyRef.current) return;
    if (configDirtyRef.current || savedConfigKey.current !== configKey())
      void saveConfig();
  }, [
    activeSessionId,
    buildConfig,
    configReady,
    loading,
    running,
    exporting,
    speakerUpdating,
    saveConfig,
    configRecovery,
  ]);

  // ── 会话生命周期 ──────────────────────────────────────────────────────────
  const loadSession = useCallback(
    async (nextSubtitle: string, nextVideo: string | null) => {
      const revision = ++loadRevisionRef.current;
      const isCurrent = () =>
        mountedRef.current && revision === loadRevisionRef.current;
      setLoading(true);
      setLoadError(null);
      setBatchSummary(null);
      setExportResult(null);
      setPercent(0);
      setRestoredFromSession(false);
      setStaleRestore(null);
      let flight = loadPendingRef.current;
      const reuseFlight =
        !!flight &&
        flight.subtitle === nextSubtitle &&
        flight.video === nextVideo &&
        !rebuildSessionIdRef.current;
      const previousLease = ownedSessionRef.current;
      const rebuilding = !!rebuildSessionIdRef.current;
      if (previousLease && !rebuilding && !reuseFlight) {
        ownedSessionRef.current = null;
        releaseLease(previousLease);
      }
      sessionIdRef.current = null;
      setSession(null);
      setCues([]);
      setRunning(false);
      setExporting(false);
      setIsCancelling(false);
      setActionError(null);
      if (!reuseFlight) {
        cueDrafts.reset();
        configJournalRef.current = null;
        journalIntentRef.current = false;
        setRecovery(null);
      }
      // StrictMode may repeat setup before the first IPC returns. Share only
      // that identical in-flight load; a different input always gets a new one.
      if (!reuseFlight) {
        if (flight) releaseLease({ leaseId: flight.leaseId });
        const restoreId = restoreSessionIdRef.current;
        restoreSessionIdRef.current = null;
        const rebuildId = rebuildSessionIdRef.current;
        rebuildSessionIdRef.current = null;
        const leaseId =
          rebuilding && previousLease
            ? previousLease.leaseId
            : crypto.randomUUID();
        flight = {
          subtitle: nextSubtitle,
          video: nextVideo,
          restoreId,
          leaseId,
          promise: window.ipc.invoke('dubbing:loadSubtitle', {
            leaseId,
            subtitlePath: nextSubtitle,
            videoPath: nextVideo || undefined,
            sessionId: restoreId || undefined,
            rebuildSessionId: rebuildId || undefined,
            workItemId: workItemIdRef.current || undefined,
            proofreadDataFile: proofreadDataFileRef.current || undefined,
          }),
        };
        loadPendingRef.current = flight;
      }
      if (!flight) return;
      const { restoreId } = flight;
      try {
        const result = await flight.promise;
        if (!isCurrent()) {
          if (
            (!mountedRef.current || loadPendingRef.current !== flight) &&
            !result.data?.locked
          ) {
            releaseLease({ leaseId: flight.leaseId });
          }
          return;
        }
        if (result?.data?.locked) {
          lockedSessionRef.current = result.data.sessionId;
          setLockedSessionId(result.data.sessionId);
          return;
        }
        lockedSessionRef.current = null;
        setLockedSessionId(null);
        if (!result.success) {
          setSession(null);
          setCues([]);
          setLoadError(result.error || 'load failed');
          return;
        }
        const data = result.data as
          | (DubbingSessionView & { restored?: boolean })
          | {
              stale: true;
              subtitlePath: string;
              videoPath?: string;
              workItemId?: string;
            };
        if ('stale' in data && data.stale) {
          workItemIdRef.current = data.workItemId || workItemIdRef.current;
          ownedSessionRef.current = {
            sessionId: restoreId!,
            leaseId: flight.leaseId,
          };
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
        ownedSessionRef.current = {
          sessionId: view.sessionId,
          leaseId: flight.leaseId,
        };
        workItemIdRef.current = view.workItemId || null;
        const normalizedView: DubbingSessionView & { restored?: boolean } = {
          ...view,
          leaseId: flight.leaseId,
          speakers: view.speakers || [],
          speakerVoiceMap: view.speakerVoiceMap || {},
          speakerVoiceConflicts: view.speakerVoiceConflicts || {},
        };
        setSession(normalizedView);
        setCues(view.cues);
        if (view.operationRecovery?.status === 'interrupted')
          setActionError(t('operationInterrupted'));
        else if (view.operationRecovery?.persistenceError)
          setActionError(
            t('operationReceiptFailed', {
              error: view.operationRecovery.persistenceError,
            }),
          );
        else if (
          view.operationRecovery?.status === 'complete' &&
          view.operationRecovery.channel === 'dubbing:export' &&
          view.operationRecovery.result?.success &&
          view.operationRecovery.result.data?.outputPath
        )
          setExportResult(view.operationRecovery.result.data);
        if (view.configSnapshot) {
          const snapshot = view.configSnapshot;
          setPersisted((prev) => ({
            ...prev,
            ...snapshot,
            engineKey:
              snapshot.engine.kind === 'local'
                ? `local:${snapshot.engine.modelId}`
                : `cloud:${snapshot.engine.providerId}`,
            language: snapshot.language || 'auto',
            audioFormat: snapshot.audioFormat ?? prev.audioFormat,
            overflow: snapshot.overflow ?? prev.overflow,
            exportShiftedSubtitle:
              snapshot.exportShiftedSubtitle ?? prev.exportShiftedSubtitle,
          }));
          savedPreferences.current = persistedRef.current;
        } else {
          setPersisted((prev) => ({ ...prev, language: 'auto' }));
        }
        savedPreferences.current = persistedRef.current;
        if (view.running) setRunning(true);
        await inspectConfigDraft(view.sessionId);
        if (!isCurrent()) return;
        await cueDrafts.inspect({
          sessionId: view.sessionId,
          leaseId: flight.leaseId,
        });
        if (!isCurrent()) return;
        if (view.restored) setRestoredFromSession(true);
        // 批量在后台进行中（页面离开后回连）：恢复运行态，进度事件自动续接
        // 仅凭会话 id 恢复（检查员模式/回开未携字幕路径）：把元数据里的
        // 文件路径回填到状态供文件条/播放器展示；ref 挡住 effect 的重复加载
        if (view.subtitlePath && (!nextSubtitle || view.restored)) {
          syncFromRestoreRef.current = true;
          setSubtitleState(view.subtitlePath);
          setVideoState(view.videoPath ?? null);
          if (nextSubtitle === view.subtitlePath)
            syncFromRestoreRef.current = false;
        }
      } catch (e) {
        releaseLease({ leaseId: flight.leaseId });
        if (!isCurrent()) return;
        setSession(null);
        setCues([]);
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (isCurrent()) {
          loadPendingRef.current = null;
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!lockedSessionId) return;
    const timer = setInterval(() => {
      if (loadPendingRef.current) return;
      restoreSessionIdRef.current = lockedSessionId;
      void loadSession(subtitleInputRef.current || '', null);
    }, 1000);
    return () => clearInterval(timer);
  }, [lockedSessionId, loadSession]);

  /** 字幕已变 → 用户确认重建：删除旧会话数据后按当前字幕新建 */
  const confirmRebuild = useCallback(() => {
    if (!staleRestore) return;
    const { sessionId, subtitlePath: sub, videoPath: vid } = staleRestore;
    setStaleRestore(null);
    rebuildSessionIdRef.current = sessionId;
    setSubtitleState(sub);
    setVideoState(vid || null);
    loadSession(sub, vid || null);
  }, [staleRestore, loadSession]);

  /** 放弃重建：回到空态（旧会话数据保留） */
  const cancelRebuild = useCallback(() => {
    const lease = ownedSessionRef.current;
    ownedSessionRef.current = null;
    if (lease) releaseLease(lease);
    setStaleRestore(null);
    workItemIdRef.current = null;
    proofreadDataFileRef.current = null;
    setSubtitleState(null);
    setVideoState(null);
  }, []);

  // 字幕/视频路径变化 → 重建会话（含 query 预填首载）。
  // 仅携 session id 打开（检查员模式跳转）时走纯恢复：字幕路径在会话元数据里，
  // 恢复成功后回填状态（syncFromRestoreRef 挡住由回填触发的本 effect 重入）。
  useEffect(() => {
    if (!configReady) return;
    if (syncFromRestoreRef.current) {
      syncFromRestoreRef.current = false;
      return;
    }
    if (subtitlePath) {
      loadSession(subtitlePath, videoPath);
    } else if (
      restoreSessionIdRef.current ||
      loadPendingRef.current?.restoreId
    ) {
      loadSession('', null);
    } else {
      loadRevisionRef.current++;
      if (loadPendingRef.current)
        releaseLease({ leaseId: loadPendingRef.current.leaseId });
      loadPendingRef.current = null;
      setLoading(false);
      const staleLease = ownedSessionRef.current;
      ownedSessionRef.current = null;
      if (staleLease) releaseLease(staleLease);
      setSession(null);
      setCues([]);
      cueDrafts.reset();
      configJournalRef.current = null;
      journalIntentRef.current = false;
      setRecovery(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitlePath, configReady]);

  // 卸载时释放会话：批量进行中则后台继续（keepRunning），
  // 经最近任务回开可实时重连；空闲会话正常释放内存态。
  useEffect(() => {
    return () => {
      const staleLease = ownedSessionRef.current;
      ownedSessionRef.current = null;
      if (staleLease) releaseLease(staleLease);
      // StrictMode immediately remounts the same load; real departure cancels it.
      const flight = loadPendingRef.current;
      if (flight)
        queueMicrotask(() => {
          if (!mountedRef.current) releaseLease({ leaseId: flight.leaseId });
        });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickSubtitle = useCallback(async () => {
    const r = await window.ipc.invoke('dubbing:pickFile', { kind: 'subtitle' });
    if (r.success && r.data) setSubtitlePath(r.data);
  }, [setSubtitlePath]);

  const setVideoPath = useCallback(
    async (nextVideo: string | null) => {
      if (
        speakerMutationRef.current ||
        running ||
        exporting ||
        configBlockedRef.current()
      )
        return;
      if (!session || session.subtitlePath !== subtitleInputRef.current) {
        setVideoState(nextVideo);
        return;
      }
      if (loading) return;
      const id = session.sessionId;
      speakerMutationRef.current = true;
      setSpeakerUpdating(true);
      setActionError(null);
      try {
        const result = await window.ipc.invoke('dubbing:setMedia', {
          sessionId: id,
          leaseId: session.leaseId,
          videoPath: nextVideo,
        });
        if (!result?.success)
          throw new Error(result?.error || 'Media update failed');
        if (!ownsLease(session.leaseId) || sessionIdRef.current !== id) return;
        setVideoState(result.data.videoPath ?? null);
        if (result.data.cues) setCues(result.data.cues);
        setSession((current) =>
          current?.sessionId === id
            ? {
                ...current,
                videoPath: result.data.videoPath,
                mediaDurationMs: result.data.mediaDurationMs,
              }
            : current,
        );
        setExportResult(null);
      } catch (error) {
        if (mountedRef.current && sessionIdRef.current === id)
          setActionError(
            error instanceof Error ? error.message : String(error),
          );
      } finally {
        speakerMutationRef.current = false;
        if (mountedRef.current) setSpeakerUpdating(false);
      }
    },
    [session, loading, running, exporting],
  );
  const pickVideo = useCallback(async () => {
    const r = await window.ipc.invoke('dubbing:pickFile', { kind: 'video' });
    if (r.success && r.data) await setVideoPath(r.data);
  }, [setVideoPath]);

  const clearVideo = useCallback(() => setVideoPath(null), [setVideoPath]);
  const clearSubtitle = useCallback(() => {
    if (
      lockedSessionRef.current ||
      configRecoveryRef.current ||
      configDiscardingRef.current ||
      configDirtyRef.current ||
      configSavePromise.current ||
      cueDrafts.blocked()
    )
      return;
    workItemIdRef.current = null;
    proofreadDataFileRef.current = null;
    setSubtitleState(null);
    setVideoState(null);
  }, []);

  // ── 批量合成 ──────────────────────────────────────────────────────────────
  const start = useCallback(
    async (opts?: {
      force?: boolean;
      staleOnly?: boolean;
      speakerId?: number;
    }) => {
      const config = buildConfig();
      if (
        !session ||
        !config ||
        configBlockedRef.current() ||
        loading ||
        unsupportedLanguage ||
        running ||
        exporting ||
        batchRequestRef.current?.sessionId === session.sessionId ||
        exportRequestRef.current?.sessionId === session.sessionId ||
        speakerMutationRef.current ||
        missingSpeakerVoiceIds.length > 0 ||
        conflictingSpeakerIds.length > 0 ||
        invalidCueOverrideCount > 0
      )
        return;
      const request = {
        sessionId: session.sessionId,
        leaseId: session.leaseId,
      };
      batchRequestRef.current = request;
      const isCurrent = () =>
        mountedRef.current &&
        ownsLease(request.leaseId) &&
        sessionIdRef.current === request.sessionId &&
        batchRequestRef.current === request;
      runningRef.current = true;
      setRunning(true);
      setActionError(null);
      setBatchSummary(null);
      setExportResult(null);
      setPercent(0);
      try {
        const result = await invokeDubbingOperation(
          'dubbing:start',
          {
            ...request,
            config,
            force: opts?.force,
            staleOnly: opts?.staleOnly,
            speakerId: opts?.speakerId,
          },
          isCurrent,
          setActionError,
        );
        if (!isCurrent()) return;
        if (result?.success && Array.isArray(result.data?.cues)) {
          const batch = result.data as DubbingBatchView;
          setActionError(
            result.recoveryWarning
              ? t('operationReceiptFailed', { error: result.recoveryWarning })
              : null,
          );
          setCues(batch.cues);
          setBatchSummary(batch);
        } else if (!result?.cancelled) {
          throw new Error(result?.error || 'Synthesis failed');
        }
      } catch (error) {
        if (isCurrent()) setActionError(String(error));
      } finally {
        if (isCurrent()) {
          runningRef.current = false;
          setRunning(false);
          setIsCancelling(false);
        }
        if (batchRequestRef.current === request) batchRequestRef.current = null;
      }
    },
    [
      session,
      buildConfig,
      running,
      exporting,
      missingSpeakerVoiceIds,
      conflictingSpeakerIds,
      invalidCueOverrideCount,
      unsupportedLanguage,
      loading,
    ],
  );

  const cancel = useCallback(async () => {
    if (
      !session ||
      isCancelling ||
      cancelRequestRef.current?.sessionId === session.sessionId
    )
      return;
    const request = { sessionId: session.sessionId, leaseId: session.leaseId };
    cancelRequestRef.current = request;
    const isCurrent = () =>
      ownsLease(request.leaseId) && sessionIdRef.current === request.sessionId;
    setIsCancelling(true);
    setActionError(null);
    try {
      const result = await window.ipc.invoke('dubbing:cancel', request);
      if (!result?.success)
        throw new Error(result?.error || 'Cancellation failed');
    } catch (error) {
      if (isCurrent()) setActionError(String(error));
    } finally {
      if (cancelRequestRef.current === request) cancelRequestRef.current = null;
      if (isCurrent()) setIsCancelling(false);
    }
  }, [session, isCancelling]);

  // ── 行级操作 ──────────────────────────────────────────────────────────────
  const applyCue = useCallback((cue: DubbingCueView) => {
    setCues((prev) => prev.map((c) => (c.index === cue.index ? cue : c)));
  }, []);

  const resynthesizeCue = useCallback(
    async (
      index: number,
      overrides?: {
        text?: string;
        voiceId?: string;
        shortenProviderId?: string;
      },
    ): Promise<boolean> => {
      if (overrides?.text !== undefined) {
        const cue = cues.find((entry) => entry.index === index);
        if (
          !cue ||
          !cueDrafts.edit(cue, overrides.text) ||
          !(await cueDrafts.save(index))
        )
          return false;
      }
      const config = buildConfig();
      if (
        !session ||
        !config ||
        loading ||
        running ||
        exporting ||
        configBlockedRef.current() ||
        speakerMutationRef.current
      )
        return false;
      const id = session.sessionId;
      const isCurrent = () =>
        ownsLease(session.leaseId) && sessionIdRef.current === id;
      speakerMutationRef.current = true;
      setSpeakerUpdating(true);
      voiceRevisionRef.current++;
      setActionError(null);
      // 本地即时反馈：行状态转合成中。
      setCues((prev) =>
        prev.map((c) =>
          c.index === index ? { ...c, status: 'synthesizing' } : c,
        ),
      );
      let synthesisStarted = false;
      try {
        let text = overrides?.text;
        if (overrides?.shortenProviderId) {
          const cue = cues.find((entry) => entry.index === index);
          if (!cue) return false;
          const original = stripSpeakerLabelPrefix(cue.text).trim();
          const prefix = cue.text.slice(
            0,
            cue.text.length - stripSpeakerLabelPrefix(cue.text).length,
          );
          const requestId = crypto.randomUUID();
          let cancelled = false;
          let release!: (value: any) => void;
          const cancellation = new Promise((resolve) => {
            release = resolve;
          });
          shortenRequest.current = {
            id: requestId,
            cancel: () => {
              cancelled = true;
              release({ success: false, cancelled: true });
            },
          };
          setShorteningIndex(index);
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            cancelShortening();
          }, 60000);
          let optimized;
          try {
            optimized = await Promise.race([
              cancellation,
              window.ipc.invoke('optimizeSubtitle', {
                providerId: overrides.shortenProviderId,
                batchId: requestId,
                mode: 'transcript',
                intent: 'shorten',
                sourceLanguage: speechLanguage || 'auto',
                sourceText: original,
                targetText: '',
                customPrompt:
                  aiPrompt('transcript', false, 'shorten') +
                  `\nTarget spoken duration: ${Math.max(0, cue.endMs - cue.startMs) / 1000} seconds.`,
              }),
            ]);
          } finally {
            clearTimeout(timer);
            if (shortenRequest.current?.id === requestId)
              shortenRequest.current = null;
            if (mountedRef.current) setShorteningIndex(null);
          }
          if (!isCurrent()) return false;
          if (timedOut) throw new Error(t('shortenTimeout'));
          if (
            cancelled ||
            JSON.stringify(latestConfig.current()) !== JSON.stringify(config)
          ) {
            applyCue(cue);
            return false;
          }
          if (!optimized?.success)
            throw new Error(optimized?.error || t('shortenFailed'));
          const proposed =
            typeof optimized.data === 'string' ? optimized.data.trim() : '';
          if (
            !proposed ||
            Array.from(proposed).length >= Array.from(original).length
          )
            throw new Error(t('shortenNotShorter'));
          text = prefix + proposed;
        }
        synthesisStarted = true;
        const result = await invokeDubbingOperation(
          'dubbing:resynthesizeCue',
          {
            sessionId: id,
            leaseId: session.leaseId,
            index,
            text,
            voiceId: overrides?.voiceId,
            config,
            expectedCue: overrides?.shortenProviderId
              ? (() => {
                  const original = cues.find((entry) => entry.index === index)!;
                  return {
                    text: original.text,
                    wavPath: original.wavPath,
                    synthesizedInputKey: original.synthesizedInputKey,
                    voiceId: original.voiceId,
                  };
                })()
              : undefined,
          },
          isCurrent,
          setActionError,
        );
        if (!isCurrent()) return false;
        if (result.success && result.data) {
          setActionError(
            result.recoveryWarning
              ? t('operationReceiptFailed', { error: result.recoveryWarning })
              : null,
          );
          applyCue(result.data as DubbingCueView);
          return true;
        }
        // The backend may have saved the requested voice/text before synthesis failed.
        const synced = await window.ipc.invoke('dubbing:syncVoiceState', {
          sessionId: id,
          leaseId: session.leaseId,
          config,
        });
        if (!isCurrent()) return false;
        if (synced?.success && synced.data?.cues) setCues(synced.data.cues);
        if (result.cancelled) return false;
        throw new Error(result.error || 'resynthesize failed');
      } catch (error) {
        if (!isCurrent()) return false;
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        setCues((prev) =>
          prev.map((c) =>
            c.index === index
              ? {
                  ...c,
                  status: synthesisStarted
                    ? 'failed'
                    : (cues.find((entry) => entry.index === index)?.status ??
                      'overlong'),
                  error: message,
                  needsUpdate: synthesisStarted
                    ? Boolean(c.wavPath) || c.needsUpdate
                    : c.needsUpdate,
                }
              : c,
          ),
        );
        return false;
      } finally {
        speakerMutationRef.current = false;
        if (mountedRef.current) setSpeakerUpdating(false);
      }
    },
    [
      session,
      cues,
      buildConfig,
      applyCue,
      loading,
      running,
      exporting,
      cancelShortening,
      speechLanguage,
      t,
    ],
  );

  const borrowSilence = useCallback(
    async (index: number): Promise<boolean> => {
      const config = buildConfig();
      if (
        !session ||
        !config ||
        loading ||
        running ||
        exporting ||
        configBlockedRef.current() ||
        speakerMutationRef.current
      )
        return false;
      const id = session.sessionId;
      const isCurrent = () =>
        ownsLease(session.leaseId) && sessionIdRef.current === id;
      speakerMutationRef.current = true;
      setSpeakerUpdating(true);
      voiceRevisionRef.current++;
      setActionError(null);
      try {
        const result = await window.ipc.invoke('dubbing:borrowSilence', {
          sessionId: id,
          leaseId: session.leaseId,
          index,
          config,
        });
        if (!isCurrent()) return false;
        if (!result?.success || !result.data)
          throw new Error(result?.error || 'Silence borrowing failed');
        applyCue(result.data);
        return true;
      } catch (error) {
        if (isCurrent())
          setActionError(
            error instanceof Error ? error.message : String(error),
          );
        return false;
      } finally {
        speakerMutationRef.current = false;
        if (mountedRef.current) setSpeakerUpdating(false);
      }
    },
    [session, buildConfig, applyCue, loading, running, exporting],
  );

  // 行级 voice 覆盖：已合成的行立即重合成;pending 行仅记录,批量时生效。
  const setCueVoice = useCallback(
    async (index: number, voiceId: string): Promise<boolean> => {
      const cue = cues.find((c) => c.index === index);
      if (
        !cue ||
        !session ||
        loading ||
        running ||
        exporting ||
        configBlockedRef.current() ||
        speakerMutationRef.current
      )
        return false;
      if (cue.wavPath) {
        return resynthesizeCue(index, { voiceId });
      }
      const id = session.sessionId;
      const isCurrent = () =>
        ownsLease(session.leaseId) && sessionIdRef.current === id;
      speakerMutationRef.current = true;
      setSpeakerUpdating(true);
      voiceRevisionRef.current++;
      setActionError(null);
      try {
        const result = await window.ipc.invoke('dubbing:setCueVoice', {
          sessionId: id,
          leaseId: session.leaseId,
          index,
          voiceId,
        });
        if (!result?.success || !result.data)
          throw new Error(result?.error || 'Voice update failed');
        if (!isCurrent()) return false;
        applyCue(result.data);
        return true;
      } catch (error) {
        if (isCurrent())
          setActionError(
            error instanceof Error ? error.message : String(error),
          );
        return false;
      } finally {
        speakerMutationRef.current = false;
        if (mountedRef.current) setSpeakerUpdating(false);
      }
    },
    [cues, resynthesizeCue, applyCue, session, loading, running, exporting],
  );

  const updateSpeaker = useCallback(
    async (channel: string, payload: Record<string, unknown>) => {
      const config = buildConfig();
      if (
        !session ||
        !config ||
        loading ||
        running ||
        exporting ||
        configBlockedRef.current() ||
        speakerMutationRef.current
      )
        return false;
      const id = session.sessionId;
      speakerMutationRef.current = true;
      setSpeakerUpdating(true);
      voiceRevisionRef.current++;
      setActionError(null);
      try {
        const result = await window.ipc.invoke(channel, {
          ...payload,
          sessionId: id,
          leaseId: session.leaseId,
          globalVoiceId: config.voice,
          config,
        });
        if (!result?.success || !result.data)
          throw new Error(result?.error || 'Speaker settings update failed');
        if (!ownsLease(session.leaseId) || sessionIdRef.current !== id)
          return false;
        const data = result.data;
        setSession((current) =>
          current?.sessionId === id
            ? {
                ...current,
                speakerVoiceMap:
                  data.speakerVoiceMap ?? current.speakerVoiceMap,
                speakerVoiceConflicts:
                  data.speakerVoiceConflicts ?? current.speakerVoiceConflicts,
                speakerSettings:
                  data.speakerSettings ?? current.speakerSettings,
                speakerSettingsConflicts:
                  data.speakerSettingsConflicts ??
                  current.speakerSettingsConflicts,
              }
            : current,
        );
        setCues(data.cues);
        return true;
      } catch (error) {
        if (ownsLease(session.leaseId) && sessionIdRef.current === id)
          setActionError(
            error instanceof Error ? error.message : String(error),
          );
        return false;
      } finally {
        speakerMutationRef.current = false;
        if (mountedRef.current) setSpeakerUpdating(false);
      }
    },
    [session, buildConfig, running, exporting, loading],
  );
  const setSpeakerVoice = useCallback(
    (speakerId: number, voiceId: string) =>
      updateSpeaker('dubbing:setSpeakerVoice', { speakerId, voiceId }),
    [updateSpeaker],
  );
  const setSpeakerSettings = useCallback(
    (speakerId: number, settings: DubbingSpeakerSettings) =>
      updateSpeaker('dubbing:setSpeakerSettings', { speakerId, settings }),
    [updateSpeaker],
  );

  const regenerateSpeaker = useCallback(
    async (speakerId: number) => {
      await start({ staleOnly: true, speakerId });
    },
    [start],
  );

  const regenerateStale = useCallback(async () => {
    await start({ staleOnly: true });
  }, [start]);

  // ── 播放（行级回放 / 试听 / 顺序播放全部）────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const playAllRef = useRef(false);
  const stopPreviewRef = useRef<() => void>(() => {});
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
  useEffect(
    () => () => {
      playAllRef.current = false;
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [activeSessionId],
  );

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
    stopPreviewRef.current();
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
      stopPreviewRef.current();
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

  const {
    previewVoice,
    stopPreview,
    previewing,
    previewVoiceId,
    previewLoading,
  } = useVoicePreview({
    config: buildConfig(),
    session,
    stopPlayback: stopPlayAll,
    onError: setActionError,
  });
  stopPreviewRef.current = stopPreview;

  // ── 导出 ──────────────────────────────────────────────────────────────────
  const [staleExportWarning, setStaleExportWarning] = useState(false);
  // 返回导出结果视图（失败/中断返回 null），调用方据此做成功通知。
  const exportDubbing =
    useCallback(async (): Promise<DubbingExportView | null> => {
      const config = buildConfig();
      if (
        !session ||
        !config ||
        exporting ||
        running ||
        batchRequestRef.current?.sessionId === session.sessionId ||
        exportRequestRef.current?.sessionId === session.sessionId ||
        speakerMutationRef.current ||
        configBlockedRef.current()
      )
        return null;
      if (cues.some((cue) => cue.needsUpdate)) {
        setStaleExportWarning(true);
        return null;
      }
      const request = {
        sessionId: session.sessionId,
        leaseId: session.leaseId,
      };
      exportRequestRef.current = request;
      const isCurrent = () =>
        mountedRef.current &&
        ownsLease(request.leaseId) &&
        sessionIdRef.current === request.sessionId &&
        exportRequestRef.current === request;
      exportingRef.current = true;
      setExporting(true);
      setActionError(null);
      try {
        const result = await invokeDubbingOperation(
          'dubbing:export',
          {
            ...request,
            config,
          },
          isCurrent,
          setActionError,
        );
        if (!isCurrent()) return null;
        if (
          result?.success &&
          typeof result.data?.outputPath === 'string' &&
          result.data.outputPath
        ) {
          const view = result.data as DubbingExportView;
          setActionError(
            result.recoveryWarning
              ? t('operationReceiptFailed', { error: result.recoveryWarning })
              : null,
          );
          setExportResult(view);
          return view;
        }
        if (!result?.cancelled)
          throw new Error(result?.error || 'Export failed');
        return null;
      } catch (error) {
        if (isCurrent()) setActionError(String(error));
        return null;
      } finally {
        if (isCurrent()) {
          exportingRef.current = false;
          setExporting(false);
        }
        if (exportRequestRef.current === request)
          exportRequestRef.current = null;
      }
    }, [session, buildConfig, exporting, running, cues]);

  const cancelStaleExport = useCallback(() => {
    setStaleExportWarning(false);
  }, []);

  const confirmStaleRegeneration = useCallback(async () => {
    setStaleExportWarning(false);
    await regenerateStale();
  }, [regenerateStale]);

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
      (c) => !c.needsUpdate && (c.status === 'done' || c.status === 'accepted'),
    ).length;
    const overlap = cues.filter((c) => c.overlap).length;
    const needsUpdate = cues.filter((c) => c.needsUpdate).length;
    const generated = cues.filter((c) => c.wavPath).length;
    return {
      total: cues.length,
      done,
      overlong,
      failed,
      overlap,
      needsUpdate,
      generated,
    };
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
      if (
        c.needsUpdate ||
        !c.wavPath ||
        c.status === 'failed' ||
        c.status === 'pending'
      ) {
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
    session &&
      activeEngine &&
      activeVoice &&
      !unsupportedLanguage &&
      !running &&
      !exporting &&
      !speakerUpdating &&
      !configBlockedRef.current() &&
      missingSpeakerVoiceIds.length === 0 &&
      conflictingSpeakerIds.length === 0 &&
      invalidCueOverrideCount === 0,
  );
  const canExport = Boolean(
    session &&
      conflictingSpeakerIds.length === 0 &&
      summary.generated > 0 &&
      summary.overlong === 0 &&
      summary.failed === 0 &&
      summary.needsUpdate === 0 &&
      cues.every(
        (cue) =>
          !cue.text.trim() ||
          cue.status === 'done' ||
          cue.status === 'accepted',
      ) &&
      !running &&
      !exporting &&
      !speakerUpdating &&
      !configBlockedRef.current(),
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
    sessionLocked: !!lockedSessionId,
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
    speechLanguage,
    autoSpeechLanguage,
    unsupportedLanguage,
    speakers,
    speakerVoiceMap,
    speakerSettings,
    speakerSettingsConflicts,
    speakerUpdating,
    speakerVoiceConflicts,
    speakerMode,
    missingSpeakerVoiceIds,
    conflictingSpeakerIds,
    invalidCueOverrideCount,
    resolvedVoiceForCue,
    config: persisted,
    updateConfig,
    configSaving,
    configError,
    configDirty,
    configReady,
    configRecovery,
    restoreConfigDraft,
    retryConfigDraft,
    configBlocked: configBlockedRef.current(),
    configOnlyBlocked: configBlockedRef.current(true),
    saveConfig,
    discardConfig,
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
    cueDrafts,
    resynthesizeCue,
    borrowSilence,
    aiProviders,
    aiProviderId,
    setAiProviderId,
    reloadAiProviders,
    shorteningIndex,
    cancelShortening,
    setCueVoice,
    setSpeakerVoice,
    setSpeakerSettings,
    regenerateSpeaker,
    regenerateStale,
    playCue,
    previewVoice,
    previewing,
    stopPreview,
    previewVoiceId,
    previewLoading,
    playingKey,
    stopAudio,
    playAll,
    playingAll,
    // 导出
    exportDubbing,
    exportResult,
    staleExportWarning,
    cancelStaleExport,
    confirmStaleRegeneration,
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

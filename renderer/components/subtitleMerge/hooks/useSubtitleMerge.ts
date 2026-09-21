import { useState, useCallback, useEffect, useRef } from 'react';
import { v4 as uuid } from 'uuid';
import type {
  SubtitleStyle,
  MergeProgress,
  VideoInfo,
  SubtitleInfo,
  MergeConfig,
  MergeOutputMode,
  VideoQuality,
  EncoderMode,
  HwAccelInfo,
  UserStylePreset,
  ComposeJobView,
} from '../../../../types/subtitleMerge';
import {
  getDefaultStyle,
  getPlatformDefaultFont,
  STYLE_PRESETS,
} from '../constants';
import {
  composeDraftKey,
  type ComposeDocument,
} from '../../../lib/composeDraft';
import { useComposeDocument } from './useComposeDocument';
import { invalidSubtitleStyleFields } from '../../../../types/subtitleStyleValidation';

export type AudioTrackMode = 'replace' | 'mix' | 'addTrack';
export interface UseSubtitleMergeOptions {
  initialVideoPath?: string;
  initialSubtitlePath?: string;
  initialStyle?: SubtitleStyle;
  onProgress?: (progress: MergeProgress) => void;
  onComplete?: (outputPath: string) => void;
  onError?: (error: string) => void;
}
const idle = (): MergeProgress => ({
  percent: 0,
  timeMark: '',
  targetSize: 0,
  status: 'idle',
});
const singleFlight = (action: () => Promise<void>) => {
  let pending: Promise<void> | null = null;
  return () =>
    (pending ||= action().finally(() => {
      pending = null;
    }));
};
const extension = (path: string, doc: ComposeDocument): string => {
  const ext =
    doc.audioTrackPath && doc.audioTrackMode === 'addTrack'
      ? '.mkv'
      : doc.outputMode === 'softmux'
        ? `.${doc.softContainer}`
        : doc.videoPath?.match(/(\.[^./\\]+)$/)?.[1];
  if (!ext) return path;
  return /\.[^./\\]+$/.test(path)
    ? path.replace(/\.[^./\\]+$/, ext)
    : `${path}${ext}`;
};

export function useSubtitleMerge(options: UseSubtitleMergeOptions = {}) {
  const { initialVideoPath, initialSubtitlePath, initialStyle } = options;
  const document = useComposeDocument(
    composeDraftKey(initialVideoPath, initialSubtitlePath),
    {
      videoPath: initialVideoPath || null,
      subtitlePath: initialSubtitlePath || null,
      audioTrackPath: null,
      audioTrackMode: 'replace',
      style: initialStyle || getDefaultStyle(),
      activePresetId: 'classic',
      outputPath: null,
      outputMode: 'hardcode',
      softContainer: 'mkv',
      videoQuality: 'original',
      encoderMode: 'cpu',
    },
  );
  const { value, current, update, isBlocked, touched, epoch } = document;
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [subtitleInfo, setSubtitleInfo] = useState<SubtitleInfo | null>(null);
  const [userPresets, setUserPresets] = useState<UserStylePreset[]>([]);
  const [hwAccelInfo, setHwAccelInfo] = useState<HwAccelInfo | null>(null);
  const [hwFallbackOccurred, setHwFallbackOccurred] = useState(false);
  const [progress, setProgress] = useState<MergeProgress>(idle);
  const [isCancelling, setIsCancelling] = useState(false);
  const [reconnectJobs, setReconnectJobs] = useState<ComposeJobView[]>([]);
  const queueSnapshot = useRef<ComposeJobView[]>([]);
  const queueRevision = useRef(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isRetrying, setIsRetrying] = useState(false);
  const retrying = useRef(false);
  const retryActions = useRef(new Map<string, () => Promise<unknown> | void>());
  const busy = useRef(new Set<string>());
  const preferenceQueue = useRef(Promise.resolve());
  const preferenceVersion = useRef(0);
  const presetVersion = useRef(0);
  const presetChanges = useRef(
    new Map<string, { version: number; preset: UserStylePreset | null }>(),
  );
  const pendingPreset = useRef<{
    id: string;
    name: string;
    style: SubtitleStyle;
  } | null>(null);
  const mounted = useRef(true);
  const active = useRef(false);
  const submitting = useRef(false);
  const jobId = useRef<string | null>(null);
  const exportSnapshot = useRef<ComposeDocument | null>(null);
  const handledTerminal = useRef<string | null>(null);
  const requestId = useRef<string | null>(null);
  const submission = useRef(0);
  const outputRevision = useRef(0);
  const callbacks = useRef(options);
  callbacks.current = options;
  const fail = useCallback(
    (scope: string, cause: unknown, action: () => Promise<unknown> | void) => {
      if (mounted.current) {
        retryActions.current.set(scope, action);
        setErrors((previous) => ({ ...previous, [scope]: String(cause) }));
      }
    },
    [],
  );
  const clearError = useCallback((scope: string) => {
    retryActions.current.delete(scope);
    if (mounted.current)
      setErrors((previous) => {
        if (!(scope in previous)) return previous;
        const next = { ...previous };
        delete next[scope];
        return next;
      });
  }, []);
  const invoke = useCallback(async (channel: string, payload?: unknown) => {
    const result = await window.ipc.invoke(channel, payload);
    if (result?.success !== true)
      throw new Error(result?.error || `${channel}: invalid response`);
    return result;
  }, []);
  const editable = useCallback(
    () => mounted.current && !active.current && !isBlocked(),
    [isBlocked],
  );
  const edit = useCallback(
    (patch: Parameters<typeof update>[0], group?: string) => {
      if (!editable()) return false;
      const changed = update(patch, { group });
      if (changed) {
        jobId.current = null;
        setReconnectJobs([]);
        setProgress(idle());
      }
      return changed;
    },
    [editable, update],
  );
  const persistPreferences = useCallback(() => {
    const version = ++preferenceVersion.current;
    const write = async () => {
      if (!mounted.current || version !== preferenceVersion.current) return;
      const doc = current.current;
      try {
        const result = await invoke('subtitleMerge:setPreferences', {
          outputMode: doc.outputMode,
          softContainer: doc.softContainer,
          videoQuality: doc.videoQuality,
          encoderMode: doc.encoderMode,
        });
        if (result.data !== true) throw new Error('Preferences were not saved');
        if (version === preferenceVersion.current)
          clearError('preferencesWrite');
      } catch (error) {
        if (version === preferenceVersion.current)
          fail('preferencesWrite', error, () => {
            preferenceQueue.current = preferenceQueue.current.then(write);
            return preferenceQueue.current;
          });
      }
    };
    preferenceQueue.current = preferenceQueue.current.then(write);
  }, [invoke, clearError, fail, current]);
  const retryErrors = useCallback(async () => {
    if (retrying.current) return;
    retrying.current = true;
    setIsRetrying(true);
    try {
      // Dialog retries run sequentially; a successful unrelated read cannot
      // acknowledge a failed write or replace its original retry payload.
      const attempted = new Set<() => Promise<unknown> | void>();
      for (const [scope, action] of Array.from(retryActions.current)) {
        if (!mounted.current) break;
        if (
          retryActions.current.get(scope) === action &&
          !attempted.has(action)
        ) {
          attempted.add(action);
          await action();
        }
      }
    } finally {
      retrying.current = false;
      if (mounted.current) setIsRetrying(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submission.current++;
    };
  }, []);
  useEffect(() => {
    let live = true;
    const readPresets = singleFlight(async () => {
      if (!live) return;
      const version = presetVersion.current;
      await invoke('subtitleMerge:listStylePresets')
        .then((result) => {
          if (!Array.isArray(result.data))
            throw new Error('Invalid style preset list');
          if (live) {
            const presets = new Map<string, UserStylePreset>(
              result.data.map((preset: UserStylePreset) => [preset.id, preset]),
            );
            // Reconcile writes completed after this read began without losing
            // untouched presets or resurrecting a concurrently deleted preset.
            for (const [id, change] of Array.from(presetChanges.current)) {
              if (change.version <= version) presetChanges.current.delete(id);
              else if (change.preset) presets.set(id, change.preset);
              else presets.delete(id);
            }
            setUserPresets(Array.from(presets.values()));
            clearError('presetsRead');
          }
        })
        .catch((error) => {
          if (live) fail('presetsRead', error, readPresets);
        });
    });
    const readHardware = singleFlight(async () => {
      if (!live) return;
      await invoke('subtitleMerge:getHwAccelInfo')
        .then((result) => {
          if (live) {
            setHwAccelInfo(result.data);
            clearError('hardware');
          }
        })
        .catch((error) => {
          if (live) fail('hardware', error, readHardware);
        });
    });
    const readPreferences = singleFlight(async () => {
      if (!live) return;
      await invoke('subtitleMerge:getPreferences')
        .then((result) => {
          if (!live) return;
          clearError('preferencesRead');
          if (touched.current || active.current || isBlocked()) return;
          const prefs = result.data || {};
          update(
            (doc) => {
              const next = { ...doc };
              if (['original', 'high', 'standard'].includes(prefs.videoQuality))
                next.videoQuality = prefs.videoQuality;
              if (['hardware', 'cpu'].includes(prefs.encoderMode))
                next.encoderMode = prefs.encoderMode;
              if (['mkv', 'mp4'].includes(prefs.softContainer))
                next.softContainer = prefs.softContainer;
              if (['softmux', 'hardcode'].includes(prefs.outputMode))
                next.outputMode = prefs.outputMode;
              if (next.outputPath)
                next.outputPath = extension(next.outputPath, next);
              return next;
            },
            { system: true },
          );
        })
        .catch((error) => {
          if (live) fail('preferencesRead', error, readPreferences);
        });
    });
    void readPresets();
    void readHardware();
    void readPreferences();
    return () => {
      live = false;
    };
  }, [invoke, clearError, fail, update, isBlocked, touched, document.ready]);

  // Metadata belongs to a media selection, not to a render or an old request.
  const blocked = document.isBlocked();
  useEffect(() => {
    let live = true;
    const path = value.videoPath;
    const generation = epoch.current;
    const outputVersion = outputRevision.current;
    setVideoInfo(null);
    if (!path) {
      clearError('video');
      clearError('outputDefault');
    }
    if (!path || blocked) return;
    const readVideo = singleFlight(async () => {
      if (!live || generation !== epoch.current) return;
      try {
        const result = await invoke('subtitleMerge:getVideoInfo', {
          videoPath: path,
        });
        if (live && generation === epoch.current) {
          setVideoInfo(result.data);
          clearError('video');
        }
      } catch (error) {
        if (live && generation === epoch.current)
          fail('video', error, readVideo);
      }
      if (!live || generation !== epoch.current) return;
      if (current.current.outputPath) {
        clearError('outputDefault');
        return;
      }
      try {
        const result = await invoke('subtitleMerge:generateOutputPath', {
          videoPath: path,
          suffix: '_subtitled',
        });
        if (
          live &&
          generation === epoch.current &&
          outputVersion === outputRevision.current &&
          current.current.videoPath === path &&
          !current.current.outputPath
        ) {
          update((doc) => ({ outputPath: extension(result.data, doc) }), {
            system: true,
          });
          clearError('outputDefault');
        }
      } catch (error) {
        if (
          live &&
          generation === epoch.current &&
          outputVersion === outputRevision.current
        )
          fail('outputDefault', error, readVideo);
      }
    });
    void readVideo();
    return () => {
      live = false;
    };
  }, [
    value.videoPath,
    blocked,
    epoch.current,
    invoke,
    current,
    epoch,
    update,
    fail,
    clearError,
  ]);
  useEffect(() => {
    let live = true;
    const path = value.subtitlePath;
    setSubtitleInfo(null);
    if (!path) clearError('subtitle');
    if (!path || blocked) return;
    const readSubtitle = singleFlight(async () => {
      if (!live) return;
      await invoke('subtitleMerge:getSubtitleInfo', { subtitlePath: path })
        .then((result) => {
          if (live) {
            setSubtitleInfo(result.data);
            clearError('subtitle');
          }
        })
        .catch((error) => {
          if (live) fail('subtitle', error, readSubtitle);
        });
    });
    void readSubtitle();
    return () => {
      live = false;
    };
  }, [value.subtitlePath, blocked, epoch.current, invoke, fail, clearError]);

  const reconnectJob = useCallback(
    (id: string) => {
      if (isBlocked() || active.current || submitting.current) return;
      const job = queueSnapshot.current.find(
        (job) => job.id === id && job.source === 'subtitleMerge',
      );
      if (!job) return;
      update(
        {
          videoPath: job.videoPath,
          subtitlePath: job.subtitlePath || null,
          outputPath: job.outputPath,
          outputMode: job.subtitleMode === 'soft' ? 'softmux' : 'hardcode',
          softContainer: /\.mp4$/i.test(job.outputPath) ? 'mp4' : 'mkv',
          audioTrackPath: job.audioTrack?.trackPath || null,
          audioTrackMode: job.audioTrack?.mode || 'replace',
          ...(job.style ? { style: job.style, activePresetId: null } : {}),
          ...(job.videoQuality ? { videoQuality: job.videoQuality } : {}),
          ...(job.encoderMode ? { encoderMode: job.encoderMode } : {}),
        },
        { system: true },
      );
      document.setJob({ requestId: job.requestId, jobId: job.id });
      exportSnapshot.current = current.current;
      if (job.status === 'done') document.acceptExport(current.current);
      jobId.current = job.id;
      handledTerminal.current = null;
      active.current = ['queued', 'running'].includes(job.status);
      setReconnectJobs([]);
      setProgress({
        ...idle(),
        jobId: job.id,
        status: active.current
          ? 'processing'
          : job.status === 'done'
            ? 'completed'
            : job.status === 'error'
              ? 'error'
              : 'idle',
        percent: job.status === 'done' ? 100 : 0,
        errorMessage: job.error,
      });
    },
    [isBlocked, update, document.setJob, document.acceptExport, current],
  );

  useEffect(() => {
    const handleQueue = (jobs: ComposeJobView[]) => {
      if (!mounted.current || !Array.isArray(jobs)) return;
      queueSnapshot.current = jobs;
      if (isBlocked()) return;
      const doc = current.current;
      const same = (job: ComposeJobView) =>
        job.videoPath === doc.videoPath &&
        job.subtitlePath === doc.subtitlePath &&
        job.outputPath === doc.outputPath;
      if (!jobId.current) {
        const reference = document.job.current;
        const job = reference
          ? jobs.find(
              (job) =>
                job.source === 'subtitleMerge' &&
                (reference.jobId
                  ? job.id === reference.jobId
                  : job.requestId === reference.requestId),
            )
          : undefined;
        if (submitting.current) {
          if (job) jobId.current = job.id;
          return;
        }
        if (!job) {
          const candidates = jobs.filter(
            (job) =>
              job.source === 'subtitleMerge' &&
              ['queued', 'running'].includes(job.status) &&
              (same(job) ||
                (!touched.current && !doc.videoPath && !doc.subtitlePath)),
          );
          if (candidates.length === 1 && reference === undefined)
            reconnectJob(candidates[0].id);
          else setReconnectJobs(candidates);
          return;
        }
        jobId.current = job.id;
        reconnectJob(job.id);
      }
      const job = jobs.find((job) => job.id === jobId.current);
      if (
        !job ||
        submitting.current ||
        ['queued', 'running'].includes(job.status)
      )
        return;
      if (handledTerminal.current === job.id) return;
      handledTerminal.current = job.id;
      active.current = false;
      clearError('cancel');
      if (
        job.status === 'done' &&
        job.outputPath !== current.current.outputPath
      )
        update({ outputPath: job.outputPath }, { system: true });
      if (job.status === 'done' && exportSnapshot.current)
        document.acceptExport({
          ...exportSnapshot.current,
          outputPath: job.outputPath,
        });
      setIsCancelling(false);
      setProgress({
        ...idle(),
        status:
          job.status === 'done'
            ? 'completed'
            : job.status === 'error'
              ? 'error'
              : 'idle',
        percent: job.status === 'done' ? 100 : 0,
        errorMessage: job.error,
      });
    };
    const offQueue = window.ipc?.on(
      'compose:queue',
      (jobs: ComposeJobView[]) => {
        queueRevision.current++;
        handleQueue(jobs);
      },
    );
    const offQueued = window.ipc?.on(
      'subtitleMerge:queued',
      (event: { requestId: string; jobId: string }) => {
        if (
          !mounted.current ||
          !submitting.current ||
          event.requestId !== requestId.current
        )
          return;
        jobId.current = event.jobId;
        document.setJob({ requestId: event.requestId, jobId: event.jobId });
      },
    );
    const offProgress = window.ipc?.on(
      'subtitleMerge:progress',
      (event: MergeProgress) => {
        if (
          !mounted.current ||
          !active.current ||
          !jobId.current ||
          event.jobId !== jobId.current ||
          event.source !== 'subtitleMerge'
        )
          return;
        if (event.hwFallback) setHwFallbackOccurred(true);
        setProgress(event);
        callbacks.current.onProgress?.(event);
      },
    );
    let live = true;
    const readQueue = singleFlight(async () => {
      if (!live) return;
      const version = queueRevision.current;
      await invoke('subtitleMerge:getQueue')
        .then((result) => {
          if (!live || !Array.isArray(result.data)) return;
          if (version !== queueRevision.current) {
            clearError('queue');
            return;
          }
          const jobs = result.data as ComposeJobView[];
          handleQueue(jobs);
          clearError('queue');
        })
        .catch((error) => {
          if (live) fail('queue', error, readQueue);
        });
    });
    void readQueue();
    return () => {
      live = false;
      offQueue?.();
      offQueued?.();
      offProgress?.();
    };
  }, [
    invoke,
    current,
    touched,
    isBlocked,
    update,
    fail,
    clearError,
    blocked,
    reconnectJob,
    document.job,
    document.setJob,
    document.acceptExport,
  ]);

  const setVideoPath = useCallback(
    async (path: string) => {
      if (edit({ videoPath: path, outputPath: null })) outputRevision.current++;
    },
    [edit],
  );
  const setSubtitlePath = useCallback(
    async (path: string) => {
      edit({ subtitlePath: path });
    },
    [edit],
  );
  const withExtension = useCallback(
    (patch: Partial<ComposeDocument>) =>
      edit((doc) => {
        const next = { ...doc, ...patch };
        return {
          ...patch,
          outputPath: doc.outputPath ? extension(doc.outputPath, next) : null,
        };
      }),
    [edit],
  );
  const setAudioTrackPath = useCallback(
    (path: string) => {
      withExtension({ audioTrackPath: path });
    },
    [withExtension],
  );
  const setAudioTrackMode = useCallback(
    (mode: AudioTrackMode) => {
      withExtension({ audioTrackMode: mode });
    },
    [withExtension],
  );
  const clearAudioTrack = useCallback(() => {
    withExtension({ audioTrackPath: null });
  }, [withExtension]);
  const selectFile = useCallback(
    async (type: 'video' | 'subtitle' | 'audio') => {
      const generation = epoch.current;
      const field =
        type === 'video'
          ? 'videoPath'
          : type === 'subtitle'
            ? 'subtitlePath'
            : 'audioTrackPath';
      const previousPath = current.current[field];
      const scope = `selection:${type}`;
      const valid = () =>
        generation === epoch.current && current.current[field] === previousPath;
      const attempt = async () => {
        if (!valid()) {
          clearError(scope);
          return;
        }
        if (!editable() || busy.current.has('selection')) return;
        busy.current.add('selection');
        try {
          const result = await window.ipc.invoke('selectFile', { type });
          if (!editable() || !valid()) return;
          if (result?.canceled || result?.cancelled) {
            clearError(scope);
            return;
          }
          if (typeof result?.filePath !== 'string' || !result.filePath)
            throw new Error(result?.error || 'No file path returned');
          if (type === 'video') await setVideoPath(result.filePath);
          else if (type === 'subtitle') await setSubtitlePath(result.filePath);
          else setAudioTrackPath(result.filePath);
          clearError(scope);
        } catch (error) {
          if (valid()) fail(scope, error, attempt);
        } finally {
          busy.current.delete('selection');
        }
      };
      await attempt();
    },
    [
      editable,
      epoch,
      current,
      setVideoPath,
      setSubtitlePath,
      setAudioTrackPath,
      clearError,
      fail,
    ],
  );
  const selectVideo = useCallback(() => selectFile('video'), [selectFile]);
  const selectSubtitle = useCallback(
    () => selectFile('subtitle'),
    [selectFile],
  );
  const selectAudioTrack = useCallback(() => selectFile('audio'), [selectFile]);
  const clearFiles = useCallback(() => {
    if (
      edit({
        videoPath: null,
        subtitlePath: null,
        audioTrackPath: null,
        outputPath: null,
      })
    )
      outputRevision.current++;
  }, [edit]);
  const clearVideo = useCallback(() => {
    if (edit({ videoPath: null, outputPath: null })) outputRevision.current++;
  }, [edit]);
  const clearSubtitle = useCallback(() => {
    edit({ subtitlePath: null });
  }, [edit]);
  const setStyle = useCallback(
    (style: SubtitleStyle) => {
      edit({ style, activePresetId: null });
    },
    [edit],
  );
  const updateStyle = useCallback(
    (updates: Partial<SubtitleStyle>) => {
      edit(
        (doc) => ({
          style: { ...doc.style, ...updates },
          activePresetId: null,
        }),
        `style:${Object.keys(updates).sort().join(',')}`,
      );
    },
    [edit],
  );
  const applyPreset = useCallback(
    (id: string) => {
      const preset =
        userPresets.find((preset) => preset.id === id) ||
        STYLE_PRESETS.find((preset) => preset.id === id);
      if (preset)
        edit({
          style: {
            ...getDefaultStyle(),
            ...preset.style,
            ...(id === 'classic' ? { fontName: getPlatformDefaultFont() } : {}),
          },
          activePresetId: id,
        });
    },
    [userPresets, edit],
  );
  const resetStyle = useCallback(() => {
    edit({ style: getDefaultStyle(), activePresetId: 'classic' });
  }, [edit]);
  const persistStylePreset = useCallback(
    async function persist(
      payload: { id: string; name: string; style: SubtitleStyle },
      generation: number,
    ): Promise<UserStylePreset | null> {
      const scope = `presetSave:${payload.id}`;
      if (
        !editable() ||
        busy.current.has(scope) ||
        busy.current.has(`presetDelete:${payload.id}`)
      )
        return null;
      busy.current.add(scope);
      try {
        const result = await invoke('subtitleMerge:saveStylePreset', payload);
        if (!mounted.current) return null;
        const preset = result.data as UserStylePreset;
        if (
          preset?.id !== payload.id ||
          preset.name !== payload.name ||
          JSON.stringify(preset.style) !== JSON.stringify(payload.style)
        )
          throw new Error('Invalid saved style');
        presetChanges.current.set(preset.id, {
          version: ++presetVersion.current,
          preset,
        });
        setUserPresets((previous) => [
          ...previous.filter((item) => item.id !== preset.id),
          preset,
        ]);
        if (
          generation === epoch.current &&
          JSON.stringify(current.current.style) ===
            JSON.stringify(payload.style)
        )
          edit({ activePresetId: preset.id });
        if (pendingPreset.current?.id === payload.id)
          pendingPreset.current = null;
        clearError(scope);
        return preset;
      } catch (error) {
        fail(scope, error, () => persist(payload, generation));
        return null;
      } finally {
        busy.current.delete(scope);
      }
    },
    [editable, current, epoch, invoke, edit, clearError, fail],
  );
  const saveStylePreset = useCallback(
    async (name: string) => {
      if (!editable()) return null;
      const style = JSON.parse(JSON.stringify(current.current.style));
      const previous = pendingPreset.current;
      const payload =
        previous &&
        previous.name === name.trim() &&
        JSON.stringify(previous.style) === JSON.stringify(style)
          ? previous
          : { id: uuid(), name: name.trim(), style };
      pendingPreset.current = payload;
      return persistStylePreset(payload, epoch.current);
    },
    [editable, current, epoch, persistStylePreset],
  );
  const deleteStylePreset = useCallback(
    async function remove(id: string): Promise<boolean> {
      const scope = `presetDelete:${id}`;
      if (
        !editable() ||
        busy.current.has(scope) ||
        busy.current.has(`presetSave:${id}`)
      )
        return false;
      busy.current.add(scope);
      try {
        const response = await invoke('subtitleMerge:deleteStylePreset', id);
        if (response.data !== true) throw new Error('Preset was not deleted');
        if (!mounted.current) return false;
        presetChanges.current.set(id, {
          version: ++presetVersion.current,
          preset: null,
        });
        setUserPresets((previous) => previous.filter((item) => item.id !== id));
        if (current.current.activePresetId === id)
          edit({ activePresetId: null });
        clearError(scope);
        clearError(`presetSave:${id}`);
        if (pendingPreset.current?.id === id) pendingPreset.current = null;
        return true;
      } catch (error) {
        fail(scope, error, () => remove(id));
        return false;
      } finally {
        busy.current.delete(scope);
      }
    },
    [editable, invoke, current, edit, clearError, fail],
  );
  const setOutputPath = useCallback(
    (path: string) => {
      if (edit({ outputPath: path })) outputRevision.current++;
    },
    [edit],
  );
  const selectOutputPath = useCallback(async () => {
    const generation = epoch.current;
    const video = current.current.videoPath;
    const outputVersion = outputRevision.current;
    const valid = () =>
      generation === epoch.current &&
      video === current.current.videoPath &&
      outputVersion === outputRevision.current;
    const attempt = async () => {
      if (!valid()) {
        clearError('outputSelection');
        return;
      }
      if (!editable() || busy.current.has('outputSelection')) return;
      busy.current.add('outputSelection');
      try {
        const result = await window.ipc.invoke(
          'subtitleMerge:selectOutputPath',
          {
            defaultPath: current.current.outputPath,
          },
        );
        if (!editable() || !valid()) return;
        if (result?.canceled || result?.cancelled) {
          clearError('outputSelection');
          return;
        }
        if (
          result?.success !== true ||
          typeof result.data !== 'string' ||
          !result.data
        )
          throw new Error(result?.error || 'No output path returned');
        const doc = current.current;
        setOutputPath(
          doc.outputMode === 'softmux' ||
            (doc.audioTrackPath && doc.audioTrackMode === 'addTrack')
            ? extension(result.data, doc)
            : result.data,
        );
        clearError('outputSelection');
      } catch (error) {
        if (valid()) fail('outputSelection', error, attempt);
      } finally {
        busy.current.delete('outputSelection');
      }
    };
    await attempt();
  }, [editable, epoch, current, setOutputPath, clearError, fail]);
  const setOutputMode = useCallback(
    (outputMode: MergeOutputMode) => {
      if (withExtension({ outputMode })) persistPreferences();
    },
    [withExtension, persistPreferences],
  );
  const setSoftContainer = useCallback(
    (softContainer: 'mkv' | 'mp4') => {
      if (withExtension({ softContainer })) persistPreferences();
    },
    [withExtension, persistPreferences],
  );
  const setVideoQuality = useCallback(
    (videoQuality: VideoQuality) => {
      if (edit({ videoQuality })) persistPreferences();
    },
    [edit, persistPreferences],
  );
  const setEncoderMode = useCallback(
    (encoderMode: EncoderMode) => {
      if (edit({ encoderMode })) persistPreferences();
    },
    [edit, persistPreferences],
  );
  const encoderMode: EncoderMode =
    value.encoderMode === 'hardware' && hwAccelInfo?.available
      ? 'hardware'
      : 'cpu';

  const startMerge = useCallback(async () => {
    const doc = current.current;
    if (!editable() || !doc.videoPath || !doc.subtitlePath || !doc.outputPath)
      return;
    if (
      doc.outputMode === 'hardcode' &&
      invalidSubtitleStyleFields(doc.style).length
    )
      return;
    requestId.current = uuid();
    if (!document.setJob({ requestId: requestId.current })) return;
    exportSnapshot.current = doc;
    active.current = true;
    submitting.current = true;
    jobId.current = null;
    handledTerminal.current = null;
    const request = ++submission.current;
    let reconnected = false;
    setHwFallbackOccurred(false);
    setProgress({ ...idle(), status: 'processing' });
    try {
      const config: MergeConfig = {
        requestId: requestId.current,
        videoPath: doc.videoPath,
        subtitlePath: doc.subtitlePath,
        outputPath: doc.outputPath,
        style: doc.style,
        outputMode: doc.outputMode,
        videoQuality: doc.videoQuality,
        encoderMode,
        ...(doc.audioTrackPath
          ? {
              audioTrack: {
                mode: doc.audioTrackMode,
                trackPath: doc.audioTrackPath,
              },
            }
          : {}),
      };
      const result = await invoke('subtitleMerge:startMerge', config);
      if (!mounted.current || request !== submission.current) return;
      if (result.cancelled) setProgress(idle());
      else {
        if (typeof result.data !== 'string' || !result.data)
          throw new Error('Merge completed without an output path');
        if (result.data !== current.current.outputPath)
          update({ outputPath: result.data }, { system: true });
        document.acceptExport({ ...doc, outputPath: result.data });
        setProgress({ ...idle(), percent: 100, status: 'completed' });
        callbacks.current.onComplete?.(result.data);
      }
    } catch (error) {
      if (!mounted.current || request !== submission.current) return;
      try {
        const revision = queueRevision.current;
        const snapshot = await invoke('subtitleMerge:getQueue');
        if (!mounted.current || request !== submission.current) return;
        if (Array.isArray(snapshot.data)) {
          if (revision === queueRevision.current)
            queueSnapshot.current = snapshot.data;
          const job = queueSnapshot.current.find(
            (job) =>
              job.source === 'subtitleMerge' &&
              job.requestId === requestId.current,
          );
          if (job) {
            active.current = false;
            submitting.current = false;
            reconnectJob(job.id);
            reconnected = true;
            return;
          }
        }
      } catch {
        // Preserve the original operation error when recovery cannot be verified.
      }
      const message = error instanceof Error ? error.message : String(error);
      setProgress({ ...idle(), status: 'error', errorMessage: message });
      callbacks.current.onError?.(message);
    } finally {
      if (mounted.current && request === submission.current) {
        if (!reconnected) active.current = false;
        clearError('cancel');
        submitting.current = false;
        handledTerminal.current = active.current ? null : jobId.current;
        setIsCancelling(false);
      }
    }
  }, [
    current,
    editable,
    encoderMode,
    invoke,
    update,
    clearError,
    document.setJob,
    document.acceptExport,
    reconnectJob,
  ]);
  const cancelMerge = useCallback(async () => {
    const id = jobId.current;
    const attempt = async () => {
      if (!active.current || jobId.current !== id) {
        clearError('cancel');
        return;
      }
      if (!id || busy.current.has('cancel')) return;
      busy.current.add('cancel');
      setIsCancelling(true);
      try {
        const result = await invoke('subtitleMerge:cancelMerge', {
          jobId: id,
        });
        if (!active.current || jobId.current !== id) return;
        if (result.data !== true)
          throw new Error('The job could not be cancelled');
        clearError('cancel');
      } catch (error) {
        if (active.current && jobId.current === id) {
          fail('cancel', error, attempt);
          if (mounted.current) setIsCancelling(false);
        }
      } finally {
        busy.current.delete('cancel');
      }
    };
    await attempt();
  }, [invoke, clearError, fail]);
  const openOutputFolder = useCallback(async () => {
    const filePath = current.current.outputPath;
    const attempt = async () => {
      if (current.current.outputPath !== filePath) {
        clearError('folder');
        return;
      }
      if (!filePath || busy.current.has('folder')) return;
      busy.current.add('folder');
      try {
        const result = await invoke('subtitleMerge:openOutputFolder', {
          filePath,
        });
        if (result.data !== true)
          throw new Error('Output folder was not opened');
        clearError('folder');
      } catch (error) {
        if (current.current.outputPath === filePath)
          fail('folder', error, attempt);
      } finally {
        busy.current.delete('folder');
      }
    };
    await attempt();
  }, [current, invoke, clearError, fail]);
  const undo = useCallback(() => {
    if (editable()) {
      document.undo();
      jobId.current = null;
      setProgress(idle());
    }
  }, [editable, document.undo]);
  const redo = useCallback(() => {
    if (editable()) {
      document.redo();
      jobId.current = null;
      setProgress(idle());
    }
  }, [editable, document.redo]);
  return {
    ...value,
    encoderMode,
    videoInfo,
    subtitleInfo,
    userPresets,
    hwAccelInfo,
    hwFallbackOccurred,
    progress,
    status: progress.status,
    isCancelling,
    reconnectJobs,
    reconnectJob,
    invalidStyleFields:
      value.outputMode === 'hardcode'
        ? invalidSubtitleStyleFields(value.style)
        : [],
    canMerge: Boolean(
      value.videoPath &&
        value.subtitlePath &&
        value.outputPath &&
        !active.current &&
        (value.outputMode === 'softmux' ||
          !invalidSubtitleStyleFields(value.style).length) &&
        !blocked,
    ),
    selectVideo,
    selectSubtitle,
    selectAudioTrack,
    setVideoPath,
    setSubtitlePath,
    setAudioTrackPath,
    setAudioTrackMode,
    clearFiles,
    clearVideo,
    clearSubtitle,
    clearAudioTrack,
    setStyle,
    updateStyle,
    applyPreset,
    resetStyle,
    saveStylePreset,
    deleteStylePreset,
    selectOutputPath,
    setOutputPath,
    setOutputMode,
    setSoftContainer,
    setVideoQuality,
    setEncoderMode,
    startMerge,
    cancelMerge,
    openOutputFolder,
    document: { ...document, undo, redo },
    operationError: Object.values(errors).join('\n'),
    retryErrors,
    isRetrying,
  };
}
export type UseSubtitleMergeReturn = ReturnType<typeof useSubtitleMerge>;

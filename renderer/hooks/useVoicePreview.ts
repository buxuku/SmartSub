import { useCallback, useEffect, useRef, useState } from 'react';
import type { DubbingConfig, DubbingSessionView } from '../../types/dubbing';
import { VoicePreviewPlayer } from '../lib/voicePreviewPlayer';

export function useVoicePreview({
  config,
  session,
  stopPlayback,
  onError,
}: {
  config: DubbingConfig | null;
  session: DubbingSessionView | null;
  stopPlayback: () => void;
  onError: (message: string | null) => void;
}) {
  const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const current = useRef<{
    id: string;
    audio?: HTMLAudioElement;
    finish?: () => void;
    timer?: ReturnType<typeof setTimeout>;
    stream?: VoicePreviewPlayer;
    unsubscribe?: () => void;
  } | null>(null);
  const mounted = useRef(false);
  const cancel = useCallback(() => {
    const active = current.current;
    current.current = null;
    if (active) {
      void window.ipc
        .invoke('dubbing:cancelPreview', { requestId: active.id })
        .catch(() => undefined);
      if (active.timer) clearTimeout(active.timer);
      active.audio?.pause();
      active.stream?.stop();
      active.unsubscribe?.();
      active.finish?.();
    }
    if (mounted.current) {
      setPreviewVoiceId(null);
      setPreviewLoading(false);
    }
  }, []);
  const identity = JSON.stringify({
    engine: config?.engine,
    voice: config?.voice,
    language: config?.language,
    cloneQuality: config?.cloneQuality,
    session: session?.sessionId,
    settings: session?.speakerSettings,
  });
  useEffect(() => {
    mounted.current = true;
    cancel();
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [identity, cancel]);

  const previewVoice = useCallback(
    async (
      voiceId?: string,
      text?: string,
      speakerId?: number,
    ): Promise<boolean> => {
      if (!config) return false;
      cancel();
      stopPlayback();
      onError(null);
      const active: NonNullable<typeof current.current> = {
        id: crypto.randomUUID(),
      };
      current.current = active;
      setPreviewVoiceId(voiceId || config.voice);
      setPreviewLoading(true);
      const isCurrent = () => mounted.current && current.current === active;
      try {
        if (typeof AudioContext !== 'undefined') {
          active.stream = new VoicePreviewPlayer(
            () => {
              if (isCurrent()) setPreviewLoading(false);
            },
            (error) => {
              if (isCurrent()) {
                onError(error instanceof Error ? error.message : String(error));
                cancel();
              }
            },
          );
          active.unsubscribe = window.ipc.on(
            'dubbing:previewChunk',
            (value: any) => {
              if (!isCurrent() || value?.requestId !== active.id) return;
              try {
                active.stream?.append(
                  new Uint8Array(value.pcm),
                  value.sampleRate,
                );
              } catch (error) {
                onError(error instanceof Error ? error.message : String(error));
                cancel();
              }
            },
          );
        }
        const request = window.ipc.invoke('dubbing:previewVoice', {
          requestId: active.id,
          engine: config.engine,
          voiceId: voiceId || config.voice,
          language: config.language,
          cloneQuality: config.cloneQuality,
          sessionId: session?.sessionId,
          speakerSettings: speakerId
            ? session?.speakerSettings?.[String(speakerId)]
            : undefined,
          text,
        });
        const result = await (active.stream
          ? Promise.race([
              request,
              active.stream.completed.then(() => ({ playbackEnded: true })),
            ])
          : request);
        if (result?.playbackEnded) return isCurrent();
        if (!isCurrent() || result?.cancelled) return false;
        if (!result?.success || !result.data)
          throw new Error(result?.error || 'Voice preview failed');
        if (active.stream?.received) {
          await active.stream.finish();
          return isCurrent();
        }
        active.stream?.stop();
        setPreviewLoading(false);
        await new Promise<void>((resolve, reject) => {
          const audio = new Audio(`media://${encodeURIComponent(result.data)}`);
          active.audio = audio;
          active.finish = resolve;
          audio.onended = () => resolve();
          audio.onerror = () =>
            reject(new Error('Voice preview playback failed'));
          audio.onplaying = () => {
            if (!active.timer)
              active.timer = setTimeout(() => {
                audio.pause();
                resolve();
              }, 3000);
          };
          audio.play().catch(reject);
        });
        return isCurrent();
      } catch (error) {
        if (isCurrent())
          onError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        if (isCurrent()) cancel();
      }
    },
    [config, session, cancel, stopPlayback, onError],
  );
  return {
    previewVoice,
    stopPreview: cancel,
    previewVoiceId,
    previewLoading,
    previewing: previewVoiceId !== null,
  };
}

import { useCallback, useEffect, useState } from 'react';
import type {
  HwAccelInfo,
  UserStylePreset,
  VideoQuality,
  EncoderMode,
} from '../../types/subtitleMerge';

export interface ComposeOptions {
  styles: UserStylePreset[];
  hwInfo: HwAccelInfo | null;
  preferences: { videoQuality?: VideoQuality; encoderMode?: EncoderMode };
  loaded: boolean;
  error: boolean;
}

/** Metadata never writes a task's chosen values. Only a new wizard uses preferences. */
export default function useComposeOptions(enabled: boolean) {
  const [options, setOptions] = useState<ComposeOptions>({
    styles: [],
    hwInfo: null,
    preferences: {},
    loaded: false,
    error: false,
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    void Promise.allSettled([
      window.ipc.invoke('subtitleMerge:listStylePresets'),
      window.ipc.invoke('subtitleMerge:getHwAccelInfo'),
      window.ipc.invoke('subtitleMerge:getPreferences'),
    ]).then((results) => {
      if (disposed) return;
      const values = results.map((result) =>
        result.status === 'fulfilled' && result.value?.success
          ? result.value.data
          : null,
      );
      setOptions({
        styles: Array.isArray(values[0]) ? values[0] : [],
        hwInfo: values[1],
        preferences: values[2] || {},
        loaded: true,
        error: values.some((value) => value === null),
      });
    });
    return () => {
      disposed = true;
    };
  }, [enabled, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...options, reload };
}

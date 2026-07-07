import { useCallback, useEffect, useState } from 'react';

/** getTtsModelStatus 返回的单模型条目（渲染层共享形状）。 */
export interface TtsModelItem {
  id: string;
  installed: boolean;
  displayName: string;
  languages: string[];
  approxInstallBytes: number;
  sampleRate: number;
  defaultVoiceId: string;
  voices: Array<{ id: string; label: string }>;
}

/** 本地 TTS 模型清单的单一持有者（左栏状态点与右栏面板共用）。 */
export default function useTtsModels() {
  const [models, setModels] = useState<TtsModelItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await window?.ipc?.invoke('getTtsModelStatus');
      if (res?.success) setModels(res.models ?? []);
    } catch (e) {
      console.error('load tts model status failed:', e);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { models, loaded, refresh };
}

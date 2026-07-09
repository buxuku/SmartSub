/**
 * 克隆音色（我的音色）清单 hook：voiceClone: IPC 的读取与增删改封装。
 * 形制 useTtsProviders（loaded 标记 + refresh），但数据源在 main 侧
 * （store + 文件目录），渲染层不做防抖写回——每个动作即时落库。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ClonedVoiceView } from '../../types/voiceClone';

export default function useClonedVoices() {
  const [voices, setVoices] = useState<ClonedVoiceView[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await window.ipc.invoke('voiceClone:list');
      setVoices(r?.success ? ((r.data as ClonedVoiceView[]) ?? []) : []);
    } catch {
      setVoices([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const rename = useCallback(
    async (id: string, name: string) => {
      const r = await window.ipc.invoke('voiceClone:rename', { id, name });
      await refresh();
      return r;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      const r = await window.ipc.invoke('voiceClone:remove', { id });
      await refresh();
      return r;
    },
    [refresh],
  );

  const regenerateSample = useCallback(
    async (id: string) => {
      const r = await window.ipc.invoke('voiceClone:regenerateSample', { id });
      await refresh();
      return r;
    },
    [refresh],
  );

  const volcRefreshStatus = useCallback(
    async (id: string) => {
      const r = await window.ipc.invoke('voiceClone:volcRefreshStatus', {
        id,
      });
      await refresh();
      return r;
    },
    [refresh],
  );

  const volcRetrain = useCallback(
    async (id: string, opts?: { denoise?: boolean; mss?: boolean }) => {
      const r = await window.ipc.invoke('voiceClone:volcRetrain', {
        id,
        ...opts,
      });
      await refresh();
      return r;
    },
    [refresh],
  );

  const exportVoice = useCallback(async (id: string) => {
    return window.ipc.invoke('voiceClone:export', { id });
  }, []);

  const importVoice = useCallback(async () => {
    const r = await window.ipc.invoke('voiceClone:import');
    await refresh();
    return r;
  }, [refresh]);

  return {
    voices,
    loaded,
    refresh,
    rename,
    remove,
    regenerateSample,
    volcRefreshStatus,
    volcRetrain,
    exportVoice,
    importVoice,
  };
}

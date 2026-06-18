import { useCallback, useEffect, useState } from 'react';
import type { SherpaLibStatus } from '../../../../types/sherpa';

export interface SherpaRuntime {
  libStatus: SherpaLibStatus | null;
  installed: boolean;
  downloading: boolean;
  progress: number;
  hasUpdate: boolean;
  checkingUpdate: boolean;
  reload: () => Promise<void>;
  download: (source: string) => Promise<{ success: boolean; error?: string }>;
  checkUpdate: () => Promise<{
    success: boolean;
    hasUpdate?: boolean;
    error?: string;
  }>;
  uninstall: () => Promise<{ success: boolean; error?: string }>;
}

/**
 * FunASR 与 Qwen 共用同一份 sherpa-onnx 原生运行库。把运行库状态/下载进度上提到
 * 常驻挂载的父组件（EngineModelTab）统一持有，使得在引擎间切换时下载进度不丢失，
 * 同时消除两个面板间的逻辑重复。toast 文案交由各引擎面板按其 i18n 前缀处理。
 */
export function useSherpaRuntime(): SherpaRuntime {
  const [libStatus, setLibStatus] = useState<SherpaLibStatus | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('sherpa-lib-status');
      if (r) setLibStatus(r as SherpaLibStatus);
    } catch {
      // 忽略：保持上次状态
    }
  }, []);

  useEffect(() => {
    void reload();
    const unsub = window?.ipc?.on(
      'sherpa-lib-download-progress',
      (p: { progress: number }) => {
        if (typeof p?.progress === 'number') setProgress(p.progress);
      },
    );
    return () => {
      unsub?.();
    };
  }, [reload]);

  const download = useCallback(
    async (source: string) => {
      setDownloading(true);
      setProgress(0);
      try {
        const r = await window?.ipc?.invoke('download-sherpa-lib', { source });
        if (r?.success) {
          setHasUpdate(false);
          await reload();
          return { success: true };
        }
        return { success: false, error: r?.error };
      } catch (e) {
        return { success: false, error: String(e) };
      } finally {
        setDownloading(false);
      }
    },
    [reload],
  );

  const checkUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    try {
      const r = await window?.ipc?.invoke('check-sherpa-lib-update');
      if (!r?.success) return { success: false, error: r?.error };
      setHasUpdate(!!r.hasUpdate);
      return { success: true, hasUpdate: !!r.hasUpdate };
    } catch (e) {
      return { success: false, error: String(e) };
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  const uninstall = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('remove-sherpa-lib');
      if (r?.success) {
        setHasUpdate(false);
        await reload();
        return { success: true };
      }
      return { success: false, error: r?.error };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }, [reload]);

  return {
    libStatus,
    installed: libStatus?.installed === true,
    downloading,
    progress,
    hasUpdate,
    checkingUpdate,
    reload,
    download,
    checkUpdate,
    uninstall,
  };
}

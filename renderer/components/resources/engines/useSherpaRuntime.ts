import { useCallback, useEffect, useState } from 'react';
import type { SherpaLibStatus } from '../../../../types/sherpa';

export interface SherpaRuntime {
  libStatus: SherpaLibStatus | null;
  installed: boolean;
  reload: () => Promise<void>;
}

/**
 * FunASR / Qwen / FireRed 共用的 sherpa-onnx 原生运行库已随安装包内置（不再运行时下载）。
 * 此 hook 仅查询内置状态（installed + 内置版本），供各引擎面板展示「已随应用内置」。
 * 状态上提到常驻挂载的父组件（EngineModelTab）统一持有，避免各面板重复查询。
 */
export function useSherpaRuntime(): SherpaRuntime {
  const [libStatus, setLibStatus] = useState<SherpaLibStatus | null>(null);

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
  }, [reload]);

  return {
    libStatus,
    installed: libStatus?.installed === true,
    reload,
  };
}

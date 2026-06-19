import React from 'react';
import { useTranslation } from 'next-i18next';
import { CheckCircle2 } from 'lucide-react';
import type { EngineStatus } from '../../../../types/engine';
import type { SherpaRuntime } from './useSherpaRuntime';

interface SherpaRuntimePanelProps {
  engineKey: 'funasr' | 'qwen' | 'fireRedAsr';
  runtime: SherpaRuntime;
  status?: EngineStatus;
  infoBanner?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * FunASR / Qwen / FireRed 共用的 sherpa-onnx 运行库管理面板（展示层）。
 *
 * 运行库已随安装包内置（extraResources/sherpa/native/<platformKey>/），不再运行时下载，
 * 故本面板只展示「已内置 + 版本」状态与各引擎专属高级设置（`children`），不含下载/升级/卸载。
 */
const SherpaRuntimePanel: React.FC<SherpaRuntimePanelProps> = ({
  engineKey,
  runtime,
  status,
  infoBanner,
  children,
}) => {
  const { t } = useTranslation('resources');
  const k = (key: string) => `engines.${engineKey}.${key}`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t(k('desc'))}</p>

      {infoBanner}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/60 p-3">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
        <span className="text-sm">{t(k('builtinRuntime'))}</span>
        {runtime.libStatus?.version && (
          <span className="text-xs text-muted-foreground">
            {t(k('installedVersion'), { version: runtime.libStatus.version })}
          </span>
        )}
      </div>

      {status?.state === 'error' && status.message && (
        <p className="text-sm text-destructive">{status.message}</p>
      )}

      {children && (
        <div className="space-y-3 rounded-lg border border-muted p-3">
          <p className="text-sm font-medium">{t(k('advanced'))}</p>
          {children}
        </div>
      )}
    </div>
  );
};

export default SherpaRuntimePanel;

import React, { useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ChevronDown, Copy } from 'lucide-react';
import type {
  AddonLoadResultInfo,
  AddonVariant,
  GpuEnvironment,
  GpuMode,
} from '../../../../types/addon';
import type { InstalledAddonInfo } from './types';
import { BACKEND_LABELS, backendDisplay } from './gpuUtils';

interface GpuDiagnosticsPanelProps {
  gpuEnv: GpuEnvironment;
  activeBackend: AddonLoadResultInfo | null;
  gpuMode: GpuMode;
  selectedVersion: AddonVariant | null;
  customAddonPath: string | null;
  installedAddons: InstalledAddonInfo[];
  isDesktopGpuPlatform: boolean;
  onCopyDiagnostics: () => void;
}

const GpuDiagnosticsPanel: React.FC<GpuDiagnosticsPanelProps> = ({
  gpuEnv,
  activeBackend,
  isDesktopGpuPlatform,
  onCopyDiagnostics,
}) => {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const activeLabel = backendDisplay(activeBackend);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-medium w-full"
        >
          <ChevronDown
            className={`w-4 h-4 transition-transform ${open ? '' : '-rotate-90'}`}
          />
          {t('gpuAcceleration.diagnostics')}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <div className="space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {t('gpuAcceleration.gpu')}
            </span>
            <span className="font-medium text-right">
              {gpuEnv.gpus?.length
                ? gpuEnv.gpus.map((g) => g.name).join(' / ')
                : t('gpuAcceleration.notDetected')}
            </span>
          </div>
          {isDesktopGpuPlatform && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {t('gpuAcceleration.vulkanRuntimeLabel')}
              </span>
              <span>
                {gpuEnv.vulkanRuntime
                  ? `✓ ${t('gpuAcceleration.detected')}`
                  : `✗ ${t('gpuAcceleration.notDetected')}`}
              </span>
            </div>
          )}
          {gpuEnv.nvidia && (
            <>
              {gpuEnv.nvidia.gpuSupport.maxCudaVersion && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t('gpuAcceleration.maxCuda')}
                  </span>
                  <span>{gpuEnv.nvidia.gpuSupport.maxCudaVersion}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t('gpuAcceleration.cudaToolkit')}
                </span>
                <span>
                  {gpuEnv.nvidia.cudaToolkit.installed
                    ? gpuEnv.nvidia.cudaToolkit.version ||
                      t('gpuAcceleration.installed')
                    : t('gpuAcceleration.notInstalled')}
                </span>
              </div>
            </>
          )}
          <div className="flex items-center justify-between border-t pt-2">
            <span className="text-muted-foreground">
              {t('gpuAcceleration.lastLoad')}
            </span>
            <span className="text-right">
              {activeBackend
                ? `${activeLabel} · ${
                    activeBackend.fallback
                      ? t('gpuAcceleration.loadFallbackBadge')
                      : t('gpuAcceleration.loadSuccess')
                  } · ${new Date(activeBackend.loadedAt).toLocaleString()}`
                : t('gpuAcceleration.noLoadYet')}
            </span>
          </div>
          {(activeBackend?.failedAttempts?.length ?? 0) > 0 && (
            <div className="space-y-1">
              <span className="text-muted-foreground">
                {t('gpuAcceleration.failureDetails')}
              </span>
              {activeBackend!.failedAttempts.map((a, idx) => (
                <div
                  key={idx}
                  className="text-[11px] text-muted-foreground pl-2 break-all"
                >
                  {BACKEND_LABELS[a.backend] || a.backend}: {a.error}
                </div>
              ))}
            </div>
          )}
          <div className="pt-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onCopyDiagnostics}
            >
              <Copy className="w-3 h-3 mr-1" />
              {t('gpuAcceleration.copyDiagnostics')}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export default GpuDiagnosticsPanel;

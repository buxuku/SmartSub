import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Download,
  Trash2,
  RefreshCw,
  ArrowUpCircle,
  SlidersHorizontal,
  ChevronDown,
  Info,
} from 'lucide-react';
import { cn } from 'lib/utils';
import { formatSize } from '@/components/settings/gpu/gpuUtils';
import DownloadSourcePopover, {
  type DownloadSourceConfig,
} from '@/components/resources/engines/DownloadSourcePopover';
import type {
  EngineStatus,
  PyEngineDownloadProgress,
  PyEngineUpdateInfo,
} from '../../../../../types/engine';

// 自包含运行时（内嵌 Python 解释器 + site-packages + main.py）的近似下载体积；
// 仅用于下载按钮提示，真实字节数以下载进度 total 为准。
const PY_ENGINE_SIZE = '210MB';

const COMPUTE_TYPE_OPTIONS = [
  'auto',
  'float16',
  'int8',
  'int8_float16',
  'float32',
] as const;

interface FasterWhisperPanelProps {
  status?: EngineStatus;
  isDownloading: boolean;
  downloadProgress: PyEngineDownloadProgress | null;
  showVerifying: boolean;
  fasterInstalled: boolean;
  fasterBroken: boolean;
  hasUpdate: boolean;
  checkingUpdate: boolean;
  taskBusy: boolean;
  device: string;
  computeType: string;
  deviceOptions: string[];
  updateInfo: PyEngineUpdateInfo | null;
  /** 引擎二进制下载源配置：点击下载/升级时于气泡内选择。 */
  binarySourceConfig: DownloadSourceConfig;
  onDownload: () => void;
  onRepair: () => void;
  onUninstall: () => void;
  onCheckUpdate: () => void;
  onUpgrade: () => void;
  onDeviceChange: (v: string) => void;
  onComputeTypeChange: (v: string) => void;
}

const FasterWhisperPanel: React.FC<FasterWhisperPanelProps> = ({
  status,
  isDownloading,
  downloadProgress,
  showVerifying,
  fasterInstalled,
  fasterBroken,
  hasUpdate,
  checkingUpdate,
  taskBusy,
  device,
  computeType,
  deviceOptions,
  updateInfo,
  binarySourceConfig,
  onDownload,
  onRepair,
  onUninstall,
  onCheckUpdate,
  onUpgrade,
  onDeviceChange,
  onComputeTypeChange,
}) => {
  const { t } = useTranslation('resources');
  // 下载/修复 与 升级 各自的「下载源」气泡开关（点击对应按钮时弹出选源）。
  const [installPickerOpen, setInstallPickerOpen] = React.useState(false);
  const [upgradePickerOpen, setUpgradePickerOpen] = React.useState(false);

  const deviceValue = deviceOptions.includes(device) ? device : 'auto';
  const deviceLabel = (opt: string) =>
    t(`engines.fasterWhisper.deviceOptions.${opt}`);
  const computeLabel = (opt: string) =>
    opt === 'auto' ? t('engines.fasterWhisper.computeTypeOptions.auto') : opt;

  // 卸载按钮（带二次确认由父级处理）：随状态内联到「修复行」或「版本/检查更新行」，不单独占一行。
  const uninstallButton = (
    <Button
      size="sm"
      variant="ghost"
      className="gap-1.5 text-muted-foreground"
      onClick={onUninstall}
      disabled={taskBusy}
    >
      <Trash2 className="h-3.5 w-3.5" />
      {t('engines.fasterWhisper.uninstall')}
    </Button>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('engines.fasterWhisper.desc')}
      </p>

      {isDownloading && downloadProgress && (
        <div className="space-y-2 rounded-lg bg-muted p-3">
          <p className="text-sm font-medium">
            {t('engines.fasterWhisper.downloading')}
          </p>
          <Progress value={downloadProgress.progress} />
          {downloadProgress.total > 0 && (
            <p className="text-xs text-muted-foreground">
              {formatSize(downloadProgress.downloaded)} /{' '}
              {formatSize(downloadProgress.total)}
            </p>
          )}
        </div>
      )}

      {showVerifying && !isDownloading && (
        <div className="rounded-lg bg-muted p-3">
          <p className="text-sm font-medium">
            {t('engines.fasterWhisper.verifying')}
          </p>
        </div>
      )}

      {fasterBroken && status?.message && (
        <p className="text-sm text-destructive">{status.message}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!fasterInstalled &&
          !isDownloading &&
          !fasterBroken &&
          !showVerifying && (
            <DownloadSourcePopover
              open={installPickerOpen}
              onOpenChange={setInstallPickerOpen}
              config={binarySourceConfig}
              onConfirm={onDownload}
            >
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => setInstallPickerOpen(true)}
              >
                <Download className="h-3.5 w-3.5" />
                {t('engines.fasterWhisper.download', { size: PY_ENGINE_SIZE })}
              </Button>
            </DownloadSourcePopover>
          )}
        {fasterBroken && (
          <DownloadSourcePopover
            open={installPickerOpen}
            onOpenChange={setInstallPickerOpen}
            config={binarySourceConfig}
            onConfirm={onRepair}
          >
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setInstallPickerOpen(true)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('engines.fasterWhisper.repair')}
            </Button>
          </DownloadSourcePopover>
        )}
        {fasterBroken && uninstallButton}
      </div>

      {fasterInstalled && !isDownloading && !showVerifying && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {status?.version && (
            <span className="text-xs text-muted-foreground">
              {t('engines.fasterWhisper.installedVersion', {
                version: status.version,
              })}
            </span>
          )}
          {hasUpdate ? (
            <>
              <Badge
                variant="outline"
                className="border-primary/40 text-primary"
              >
                {t('engines.fasterWhisper.updateAvailable')}
              </Badge>
              <DownloadSourcePopover
                open={upgradePickerOpen}
                onOpenChange={setUpgradePickerOpen}
                config={binarySourceConfig}
                onConfirm={onUpgrade}
              >
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={taskBusy}
                  onClick={() => setUpgradePickerOpen(true)}
                >
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  {t('engines.fasterWhisper.upgrade')}
                </Button>
              </DownloadSourcePopover>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={checkingUpdate || taskBusy}
              onClick={onCheckUpdate}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', checkingUpdate && 'animate-spin')}
              />
              {checkingUpdate
                ? t('engines.fasterWhisper.checking')
                : t('engines.fasterWhisper.checkUpdate')}
            </Button>
          )}
          {updateInfo && !updateInfo.protocolSupported && (
            <span className="text-xs text-destructive">
              {t('engines.fasterWhisper.protocolUnsupported')}
            </span>
          )}
          <span className="ml-auto">{uninstallButton}</span>
        </div>
      )}

      {fasterInstalled && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('engines.fasterWhisper.serialNote')}
        </p>
      )}

      {fasterInstalled && (
        <Collapsible className="rounded-lg border bg-muted/30">
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
            <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t('engines.fasterWhisper.advanced')}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="hidden sm:inline">
                {t('engines.fasterWhisper.device')}: {deviceLabel(deviceValue)}{' '}
                · {t('engines.fasterWhisper.computeType')}:{' '}
                {computeLabel(computeType)}
              </span>
              <ChevronDown className="h-4 w-4 transition-transform group-data-[state=open]:rotate-180" />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <label htmlFor="fw-device" className="text-sm font-medium">
                    {t('engines.fasterWhisper.device')}
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('engines.fasterWhisper.device')}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[260px] whitespace-pre-line text-xs leading-relaxed">
                      {t('engines.fasterWhisper.deviceTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Select value={deviceValue} onValueChange={onDeviceChange}>
                  <SelectTrigger id="fw-device">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {deviceOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {deviceLabel(opt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('engines.fasterWhisper.deviceHint')}
                </p>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <label htmlFor="fw-compute" className="text-sm font-medium">
                    {t('engines.fasterWhisper.computeType')}
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={t('engines.fasterWhisper.computeType')}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[260px] whitespace-pre-line text-xs leading-relaxed">
                      {t('engines.fasterWhisper.computeTypeTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Select value={computeType} onValueChange={onComputeTypeChange}>
                  <SelectTrigger id="fw-compute">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COMPUTE_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {computeLabel(opt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('engines.fasterWhisper.computeTypeHint')}
                </p>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
};

export default FasterWhisperPanel;

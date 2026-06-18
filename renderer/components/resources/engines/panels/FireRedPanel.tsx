import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Info } from 'lucide-react';
import SherpaRuntimePanel from '@/components/resources/engines/SherpaRuntimePanel';
import type { SherpaRuntime } from '@/components/resources/engines/useSherpaRuntime';
import type { DownloadSource } from '../../../../../types/addon';
import type { EngineStatus } from '../../../../../types/engine';

interface FireRedPanelProps {
  status?: EngineStatus;
  taskBusy: boolean;
  runtime: SherpaRuntime;
  binarySource: DownloadSource;
  onBinarySourceChange: (source: DownloadSource) => void;
  onRefreshStatuses: () => void | Promise<void>;
}

const FireRedPanel: React.FC<FireRedPanelProps> = ({
  status,
  taskBusy,
  runtime,
  binarySource,
  onBinarySourceChange,
  onRefreshStatuses,
}) => {
  const { t } = useTranslation('resources');

  const [numThreads, setNumThreads] = useState(2);

  useEffect(() => {
    (async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        if (settings && typeof settings.fireRedNumThreads === 'number') {
          setNumThreads(settings.fireRedNumThreads);
        }
      } catch {
        // 忽略
      }
    })();
  }, []);

  const handleThreadsChange = async (value: string) => {
    const n = Number(value);
    setNumThreads(n);
    await window?.ipc?.invoke('set-firered-settings', { numThreads: n });
  };

  return (
    <SherpaRuntimePanel
      engineKey="fireRedAsr"
      runtime={runtime}
      status={status}
      taskBusy={taskBusy}
      binarySource={binarySource}
      onBinarySourceChange={onBinarySourceChange}
      onRefreshStatuses={onRefreshStatuses}
      infoBanner={
        <div className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('engines.fireRedAsr.desc.runtimeShared')}</span>
        </div>
      }
    >
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t('engines.fireRedAsr.providerNote')}</span>
      </p>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label className="text-sm">
            {t('engines.fireRedAsr.numThreads')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('engines.fireRedAsr.numThreadsHint')}
          </p>
        </div>
        <Select value={String(numThreads)} onValueChange={handleThreadsChange}>
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['1', '2', '4', '8'].map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </SherpaRuntimePanel>
  );
};

export default FireRedPanel;

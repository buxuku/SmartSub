import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import SherpaRuntimePanel from '@/components/resources/engines/SherpaRuntimePanel';
import type { SherpaRuntime } from '@/components/resources/engines/useSherpaRuntime';
import type { DownloadSource } from '../../../../../types/addon';
import type { EngineStatus } from '../../../../../types/engine';

interface FunasrPanelProps {
  status?: EngineStatus;
  taskBusy: boolean;
  runtime: SherpaRuntime;
  binarySource: DownloadSource;
  onBinarySourceChange: (source: DownloadSource) => void;
  onRefreshStatuses: () => void | Promise<void>;
}

const FunasrPanel: React.FC<FunasrPanelProps> = ({
  status,
  taskBusy,
  runtime,
  binarySource,
  onBinarySourceChange,
  onRefreshStatuses,
}) => {
  const { t } = useTranslation('resources');

  const [useItn, setUseItn] = useState(true);
  const [numThreads, setNumThreads] = useState(4);

  useEffect(() => {
    (async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        if (settings) {
          if (typeof settings.funasrUseItn === 'boolean')
            setUseItn(settings.funasrUseItn);
          if (typeof settings.funasrNumThreads === 'number')
            setNumThreads(settings.funasrNumThreads);
        }
      } catch {
        // 忽略
      }
    })();
  }, []);

  const handleItnChange = async (value: boolean) => {
    setUseItn(value);
    await window?.ipc?.invoke('set-funasr-settings', { useItn: value });
  };

  const handleThreadsChange = async (value: string) => {
    const n = Number(value);
    setNumThreads(n);
    await window?.ipc?.invoke('set-funasr-settings', { numThreads: n });
  };

  return (
    <SherpaRuntimePanel
      engineKey="funasr"
      runtime={runtime}
      status={status}
      taskBusy={taskBusy}
      binarySource={binarySource}
      onBinarySourceChange={onBinarySourceChange}
      onRefreshStatuses={onRefreshStatuses}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="funasr-itn" className="text-sm">
            {t('engines.funasr.itn')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('engines.funasr.itnHint')}
          </p>
        </div>
        <Switch
          id="funasr-itn"
          checked={useItn}
          onCheckedChange={handleItnChange}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label className="text-sm">{t('engines.funasr.numThreads')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('engines.funasr.numThreadsHint')}
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

export default FunasrPanel;

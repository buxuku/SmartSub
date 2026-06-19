import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
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
import { CheckCircle2, ChevronDown, Info } from 'lucide-react';
import EngineIcon from '@/components/resources/engines/EngineIcon';
import ModelLibrarySection from '@/components/resources/ModelLibrarySection';
import type { SherpaRuntime } from '@/components/resources/engines/useSherpaRuntime';
import type { EngineStatus } from '../../../../types/engine';
import type { ISystemInfo } from '../../../../types/types';

/** sherpa 系（funasr / qwen / fireRedAsr）共享同一原生运行库，仅模型与少量参数不同。 */
export type SherpaFamilyKey = 'funasr' | 'qwen' | 'fireRedAsr';

interface SherpaFamily {
  engine: SherpaFamilyKey;
  /** 运行库（sherpa-onnx）是否就绪——三族同库，通常一致。 */
  pkgInstalled: boolean;
  /** 该族模型 + VAD 是否就绪（可转写）。 */
  modelsReady: boolean;
  status?: EngineStatus;
}

interface SherpaEngineGroupPanelProps {
  runtime: SherpaRuntime;
  families: SherpaFamily[];
  systemInfo: ISystemInfo;
  systemInfoLoaded: boolean;
  globalDownloading: boolean;
  onUpdate: () => void;
}

const THREAD_OPTIONS = ['1', '2', '4', '8'];

/**
 * 单族高级设置（无运行库卡包装；运行库卡由组面板统一只渲染一次）。
 * - FunASR：ITN 逆文本规整（仅 SenseVoice 有效）+ numThreads
 * - Qwen / FireRed：providerNote + numThreads（无 ITN，内部已处理规整）
 */
const SherpaFamilyAdvanced: React.FC<{ engine: SherpaFamilyKey }> = ({
  engine,
}) => {
  const { t } = useTranslation('resources');
  const [useItn, setUseItn] = useState(true);
  const [numThreads, setNumThreads] = useState(engine === 'funasr' ? 4 : 2);

  useEffect(() => {
    (async () => {
      try {
        const settings = await window?.ipc?.invoke('getSettings');
        if (!settings) return;
        if (engine === 'funasr') {
          if (typeof settings.funasrUseItn === 'boolean')
            setUseItn(settings.funasrUseItn);
          if (typeof settings.funasrNumThreads === 'number')
            setNumThreads(settings.funasrNumThreads);
        } else if (engine === 'qwen') {
          if (typeof settings.qwenNumThreads === 'number')
            setNumThreads(settings.qwenNumThreads);
        } else if (typeof settings.fireRedNumThreads === 'number') {
          setNumThreads(settings.fireRedNumThreads);
        }
      } catch {
        // 忽略：保持默认
      }
    })();
  }, [engine]);

  const settingsChannel =
    engine === 'funasr'
      ? 'set-funasr-settings'
      : engine === 'qwen'
        ? 'set-qwen-settings'
        : 'set-firered-settings';

  const handleItnChange = async (value: boolean) => {
    setUseItn(value);
    await window?.ipc?.invoke('set-funasr-settings', { useItn: value });
  };

  const handleThreadsChange = async (value: string) => {
    const n = Number(value);
    setNumThreads(n);
    await window?.ipc?.invoke(settingsChannel, { numThreads: n });
  };

  const k = (key: string) => `engines.${engine}.${key}`;

  return (
    <div className="space-y-3 rounded-lg border border-muted p-3">
      <p className="text-sm font-medium">{t('engines.funasr.advanced')}</p>

      {engine !== 'funasr' && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t(k('providerNote'))}</span>
        </p>
      )}

      {engine === 'funasr' && (
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
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label className="text-sm">{t(k('numThreads'))}</Label>
          <p className="text-xs text-muted-foreground">
            {t(k('numThreadsHint'))}
          </p>
        </div>
        <Select value={String(numThreads)} onValueChange={handleThreadsChange}>
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THREAD_OPTIONS.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};

/**
 * sherpa 系引擎（FunASR · Qwen · FireRed）合并管理面板。
 *
 * 三者共用同一 sherpa-onnx 原生运行库（已随应用内置），差异仅在模型与少量参数，
 * 故运行库卡只在顶部渲染一次；下方按模型族分区，各族内联自己的高级设置与模型清单。
 * 未装任何模型的族默认折叠以收敛纵向长度。
 */
const SherpaEngineGroupPanel: React.FC<SherpaEngineGroupPanelProps> = ({
  runtime,
  families,
  systemInfo,
  systemInfoLoaded,
  globalDownloading,
  onUpdate,
}) => {
  const { t } = useTranslation('resources');
  const anyReady = families.some((f) => f.modelsReady);

  const familyBadge = (f: SherpaFamily) => {
    if (f.pkgInstalled && f.modelsReady) {
      return (
        <Badge variant="outline" className="border-success/40 text-success">
          {t('engines.statusAvailable')}
        </Badge>
      );
    }
    if (f.pkgInstalled && !f.modelsReady) {
      return (
        <Badge variant="outline" className="border-primary/40 text-primary">
          {t(`engines.${f.engine}.needsModels`)}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t(`engines.${f.engine}.notInstalled`)}
      </Badge>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('engines.sherpa.desc')}
      </p>

      {/* 共享运行库卡：三族同一份内置运行库，只此一处 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/60 p-3">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
        <span className="text-sm">{t('engines.sherpa.builtinRuntime')}</span>
        {runtime.libStatus?.version && (
          <span className="text-xs text-muted-foreground">
            {t('engines.sherpa.installedVersion', {
              version: runtime.libStatus.version,
            })}
          </span>
        )}
      </div>

      {!anyReady && (
        <p className="text-xs text-muted-foreground">
          {t('engines.sherpa.needsModels')}
        </p>
      )}

      {/* 三族分区：各自高级设置 + 模型清单（复用 ModelLibrarySection 的下载/导入/删除/换路径） */}
      <div className="space-y-3">
        {families.map((f, index) => (
          <Collapsible
            key={f.engine}
            defaultOpen={f.modelsReady || (!anyReady && index === 0)}
            className="rounded-lg border"
          >
            <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2.5 text-left">
              <EngineIcon engine={f.engine} className="h-4 w-4 shrink-0" />
              <span className="text-sm font-medium">
                {t(`engines.${f.engine}.name`)}
              </span>
              {familyBadge(f)}
              <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-4 border-t p-3">
                <SherpaFamilyAdvanced engine={f.engine} />
                <ModelLibrarySection
                  engine={f.engine}
                  systemInfo={systemInfo}
                  systemInfoLoaded={systemInfoLoaded}
                  globalDownloading={globalDownloading}
                  onUpdate={onUpdate}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    </div>
  );
};

export default SherpaEngineGroupPanel;

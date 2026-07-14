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
import { CheckCircle2, ChevronDown, Settings2 } from 'lucide-react';
import EngineIcon from '@/components/resources/engines/EngineIcon';
import ModelLibrarySection from '@/components/resources/ModelLibrarySection';
import type { SherpaRuntime } from '@/components/resources/engines/useSherpaRuntime';
import type { EngineStatus } from '../../../../types/engine';
import type { ISystemInfo } from '../../../../types/types';

/** sherpa 系（funasr / qwen / fireRedAsr）共享同一原生运行库，仅模型与少量参数不同。 */
export type SherpaFamilyKey = 'funasr' | 'qwen' | 'fireRedAsr';

interface SherpaFamily {
  engine: SherpaFamilyKey;
  /** 该族模型是否就绪（可转写）。运行库随包内置，不再参与判断。 */
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
 * 合并后的「高级设置」：FunASR · Qwen · FireRed 共用同一 sherpa-onnx 运行库，
 * 故线程数为统一一项（更改时同步写入三引擎设置，保持行为一致）；
 * 逆文本规整（ITN）仅 FunASR（SenseVoice）生效，单独备注说明。
 */
const SherpaAdvancedSettings: React.FC = () => {
  const { t } = useTranslation('resources');
  const [useItn, setUseItn] = useState(true);
  const [numThreads, setNumThreads] = useState(4);

  useEffect(() => {
    (async () => {
      try {
        const s = await window?.ipc?.invoke('getSettings');
        if (!s) return;
        if (typeof s.funasrUseItn === 'boolean') setUseItn(s.funasrUseItn);
        const persisted = [
          s.funasrNumThreads,
          s.qwenNumThreads,
          s.fireRedNumThreads,
        ].find((x) => typeof x === 'number');
        if (typeof persisted === 'number') setNumThreads(persisted);
      } catch {
        // 忽略：保持默认
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
    // 三族共用同一运行库，线程数统一应用到三引擎设置。
    await Promise.all([
      window?.ipc?.invoke('set-funasr-settings', { numThreads: n }),
      window?.ipc?.invoke('set-qwen-settings', { numThreads: n }),
      window?.ipc?.invoke('set-firered-settings', { numThreads: n }),
    ]);
  };

  return (
    <div className="space-y-3 border-t p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label className="text-sm">{t('engines.sherpa.numThreads')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('engines.sherpa.numThreadsHint')}
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

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="sherpa-itn" className="text-sm">
            {t('engines.sherpa.itn')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('engines.sherpa.itnHint')}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('engines.sherpa.itnFunasrOnly')}
          </p>
        </div>
        <Switch
          id="sherpa-itn"
          checked={useItn}
          onCheckedChange={handleItnChange}
        />
      </div>
    </div>
  );
};

/**
 * sherpa 系引擎（FunASR · Qwen · FireRed）合并管理面板。
 *
 * 三者共用同一 sherpa-onnx 原生运行库（已随应用内置），差异仅在模型与少量参数。
 * 运行库内置故不再做安装检测：状态只看「是否已下载模型」。
 * 顶部一次性声明运行库已内置；下方按模型族分区（仅模型清单）；
 * 全部高级设置（线程数 + ITN）合并到底部单独一处。
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

  // 运行库内置，无「未安装」态：仅区分「可用」与「需下载模型」。
  const familyBadge = (f: SherpaFamily) =>
    f.modelsReady ? (
      <Badge variant="outline" className="border-success/40 text-success">
        {t('engines.statusAvailable')}
      </Badge>
    ) : (
      <Badge variant="outline" className="border-primary/40 text-primary">
        {t(`engines.${f.engine}.needsModels`)}
      </Badge>
    );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('engines.sherpa.desc')}
      </p>

      {/* 共享运行库卡：三族同一份内置运行库，恒为就绪，只此一处 */}
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

      {/* 三族分区：仅模型清单（复用 ModelLibrarySection 的下载/导入/删除/换路径） */}
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
              <div className="border-t p-3">
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

      {/* 合并的高级设置：线程数（三族统一）+ ITN（仅 FunASR） */}
      <Collapsible className="rounded-lg border">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2.5 text-left">
          <Settings2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">
            {t('engines.sherpa.advanced')}
          </span>
          <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SherpaAdvancedSettings />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

export default SherpaEngineGroupPanel;

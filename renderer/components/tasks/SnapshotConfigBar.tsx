/**
 * 向导任务的只读配置摘要条：任务配置随创建时快照固定执行，
 * 这里按快照展示实际生效的参数（含配音/成片附加阶段与人工把关），
 * 替代可编辑的 InlineConfigBar——避免全局配置与本任务无关却可改的误导。
 */
import React, { useMemo } from 'react';
import { AudioLines, Diamond, Film, Lock } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { isSubtitleFile } from 'lib/utils';
import type { TaskTypeDef } from 'lib/taskTypes';
import { useTtsEngineOptions } from 'hooks/useTtsEngineOptions';
import { useTranslation } from 'next-i18next';

interface Provider {
  id: string;
  name: string;
  [key: string]: any;
}

interface SnapshotConfigBarProps {
  /** 任务配置快照（IFormData，含 dub/compose/gates） */
  snapshot: any;
  files: any[];
  typeDef: TaskTypeDef;
  providers: Provider[];
  asrProviders?: Provider[];
}

function SummaryItem({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {label}
      </span>
      <span className="truncate text-xs font-medium">{value}</span>
    </div>
  );
}

const SnapshotConfigBar: React.FC<SnapshotConfigBarProps> = ({
  snapshot,
  files,
  typeDef,
  providers,
  asrProviders,
}) => {
  const { t } = useTranslation('tasks');
  const { t: tHome } = useTranslation('home');
  const { t: tCommon } = useTranslation('common');
  const { engineOptions } = useTtsEngineOptions();

  // 是否存在真正要转写的文件（字幕输入/配对自带字幕的都跳过听写）
  const needsTranscription = files.length
    ? files.some(
        (f: any) =>
          !isSubtitleFile(f?.filePath || '') && !f?.providedSubtitlePath,
      )
    : typeDef.accepts === 'media';

  const translateOn =
    Boolean(snapshot?.translateProvider) && snapshot.translateProvider !== '-1';

  const languageLabel = (value?: string) => {
    if (!value) return '';
    if (value === 'auto') return tHome('autoRecognition');
    return tCommon(`language.${value}`, { defaultValue: value });
  };

  const modelValue = useMemo(() => {
    if (!snapshot?.model) return '';
    if (snapshot.transcriptionEngine === 'cloud') {
      const instance = (asrProviders ?? []).find(
        (p) => p.id === snapshot.asrProviderId,
      );
      const name = instance?.name || tCommon('engineBadge.cloud');
      return `${name} · ${snapshot.model}`;
    }
    const engineName = snapshot.transcriptionEngine
      ? tCommon(`engineBadge.${snapshot.transcriptionEngine}`, {
          defaultValue: snapshot.transcriptionEngine,
        })
      : '';
    return engineName ? `${engineName} · ${snapshot.model}` : snapshot.model;
  }, [snapshot, asrProviders, tCommon]);

  const providerValue = useMemo(() => {
    if (!translateOn) return '';
    const provider = providers.find((p) => p.id === snapshot.translateProvider);
    if (!provider) return snapshot.translateProvider;
    return tCommon(`provider.${provider.name}`, {
      defaultValue: provider.name,
    });
  }, [translateOn, providers, snapshot, tCommon]);

  const styleValue = useMemo(() => {
    switch (snapshot?.translateContent) {
      case 'onlyTranslate':
        return tHome('onlyOutputTranslationSubtitle');
      case 'sourceAndTranslate':
        return tHome('sourceAndTranslate');
      case 'translateAndSource':
        return tHome('translateAndSource');
      default:
        return '';
    }
  }, [snapshot, tHome]);

  const dubValue = useMemo(() => {
    const dub = snapshot?.dub;
    if (!dub) return '';
    const key =
      dub.engine?.kind === 'local'
        ? `local:${dub.engine.modelId}`
        : `cloud:${dub.engine?.providerId}`;
    const option = engineOptions.find((o) => o.key === key);
    const engineLabel =
      option?.label || dub.engine?.modelId || dub.engine?.providerId || '';
    const voiceLabel =
      option?.voices.find((v) => v.id === dub.voice)?.label || dub.voice || '';
    const parts = [engineLabel, voiceLabel].filter(Boolean);
    const speed = Number(dub.globalSpeed || 1);
    if (speed !== 1) parts.push(`${speed}x`);
    return parts.join(' · ');
  }, [snapshot, engineOptions]);

  const composeValue = useMemo(() => {
    const mode = snapshot?.compose?.subtitle;
    if (!mode) return '';
    if (mode === 'hard') return t('snapshotBar.composeHard');
    if (mode === 'soft') return t('snapshotBar.composeSoft');
    return t('snapshotBar.composeNone');
  }, [snapshot, t]);

  const manualGates = useMemo(() => {
    const list: string[] = [];
    if (snapshot?.gates?.subtitle === 'manual') list.push(t('gate.subtitle'));
    if (snapshot?.dub && snapshot?.gates?.dubbing === 'manual') {
      list.push(t('gate.dubbing'));
    }
    return list;
  }, [snapshot, t]);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex flex-none cursor-default items-center text-muted-foreground">
              <Lock className="h-3.5 w-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[320px]">
            {t('snapshotBar.fixedTip')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {needsTranscription && modelValue && (
        <SummaryItem label={t('configBar.model')} value={modelValue} />
      )}

      {snapshot?.sourceLanguage && (
        <SummaryItem
          label={
            needsTranscription
              ? t('configBar.sourceLanguage')
              : t('configBar.subtitleSourceLanguage')
          }
          value={languageLabel(snapshot.sourceLanguage)}
        />
      )}

      {translateOn && snapshot?.targetLanguage && (
        <SummaryItem
          label={t('configBar.targetLanguage')}
          value={languageLabel(snapshot.targetLanguage)}
        />
      )}

      {translateOn && providerValue && (
        <SummaryItem label={t('configBar.provider')} value={providerValue} />
      )}

      {translateOn && styleValue && (
        <SummaryItem label={t('configBar.style')} value={styleValue} />
      )}

      {snapshot?.dub && dubValue && (
        <SummaryItem
          label={t('stage.dubbing')}
          value={
            <span className="flex items-center gap-1">
              <AudioLines className="h-3 w-3 flex-none text-muted-foreground" />
              {dubValue}
            </span>
          }
        />
      )}

      {snapshot?.compose && composeValue && (
        <SummaryItem
          label={t('stage.compose')}
          value={
            <span className="flex items-center gap-1">
              <Film className="h-3 w-3 flex-none text-muted-foreground" />
              {composeValue}
            </span>
          }
        />
      )}

      {manualGates.map((gate) => (
        <span
          key={gate}
          className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          <Diamond className="h-3 w-3" />
          {gate}
        </span>
      ))}
    </div>
  );
};

export default SnapshotConfigBar;

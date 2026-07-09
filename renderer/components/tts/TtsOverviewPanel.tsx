/**
 * 「配音服务」右栏：总览面板（默认落地视图）——三张来源概念卡
 * （本地模型 / 在线服务 / 我的音色）+ 就绪状态 + 推荐起步路径，
 * 向新用户解释三类声音来源的差别与下一步动作。
 */
import React from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { ArrowRight, Check, Cloud, HardDrive, Mic2 } from 'lucide-react';
import { cn } from 'lib/utils';
import { TTS_EDGE, type TtsEngineView } from '../../../types/ttsProvider';
import type { ClonedVoiceView } from '../../../types/voiceClone';
import type { TtsModelItem } from './useTtsModels';

function ReadyDot({ ready }: { ready: boolean }) {
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        ready ? 'bg-success' : 'bg-muted-foreground/40',
      )}
    />
  );
}

interface QuickPath {
  key: string;
  title: string;
  desc: string;
  action: string;
  ready: boolean;
  onGo: () => void;
}

export default function TtsOverviewPanel({
  models,
  providerViews,
  voices,
  onOpenModel,
  onOpenProviderView,
  onOpenClone,
  onCreateVoice,
}: {
  models: TtsModelItem[];
  providerViews: TtsEngineView[];
  voices: ClonedVoiceView[];
  onOpenModel: (modelId: string) => void;
  onOpenProviderView: (viewId: string) => void;
  onOpenClone: (voiceId: string) => void;
  onCreateVoice: () => void;
}) {
  const { t } = useTranslation('resources');
  const { t: cloneT } = useTranslation('voiceClone');

  const firstModel = models.find((m) => !m.cloneOnly) ?? models[0];
  const installedCount = models.filter((m) => m.installed).length;
  const realViews = providerViews.filter((v) => v.kind !== 'orphan');
  const configuredCount = realViews.filter((v) => v.configured).length;
  const edgeView = realViews.find((v) => v.type.id === TTS_EDGE);

  const cards = [
    {
      key: 'local',
      icon: <HardDrive className="h-4 w-4" />,
      title: t('ttsServices.groupLocal'),
      desc: t('ttsServices.cardLocalDesc'),
      ready: installedCount > 0,
      stat: t('ttsServices.statInstalled', {
        installed: installedCount,
        total: models.length,
      }),
      action: t('ttsServices.viewLocal'),
      onGo: firstModel ? () => onOpenModel(firstModel.id) : undefined,
    },
    {
      key: 'cloud',
      icon: <Cloud className="h-4 w-4" />,
      title: t('ttsServices.groupCloud'),
      desc: t('ttsServices.cardCloudDesc'),
      ready: configuredCount > 0,
      stat: t('ttsServices.statConfigured', {
        configured: configuredCount,
        total: realViews.length,
      }),
      action: t('ttsServices.viewCloud'),
      onGo: realViews[0]
        ? () => onOpenProviderView(realViews[0].viewId)
        : undefined,
    },
    {
      key: 'voices',
      icon: <Mic2 className="h-4 w-4" />,
      title: cloneT('groupMyVoices'),
      desc: t('ttsServices.cardVoicesDesc'),
      ready: voices.length > 0,
      stat:
        voices.length > 0
          ? t('ttsServices.statVoices', { count: voices.length })
          : t('ttsServices.statNoVoices'),
      action:
        voices.length > 0 ? t('ttsServices.viewVoices') : cloneT('createVoice'),
      onGo: voices.length > 0 ? () => onOpenClone(voices[0].id) : onCreateVoice,
    },
  ];

  const paths: QuickPath[] = [];
  if (firstModel) {
    paths.push({
      key: 'local',
      title: t('ttsServices.pathLocalTitle'),
      desc: t('ttsServices.pathLocalDesc', { name: firstModel.displayName }),
      action: t('ttsServices.pathLocalAction'),
      ready: firstModel.installed,
      onGo: () => onOpenModel(firstModel.id),
    });
  }
  if (edgeView) {
    paths.push({
      key: 'edge',
      title: t('ttsServices.pathEdgeTitle'),
      desc: t('ttsServices.pathEdgeDesc'),
      action: t('ttsServices.pathEdgeAction'),
      ready: Boolean(edgeView.configured),
      onGo: () => onOpenProviderView(edgeView.viewId),
    });
  }
  paths.push({
    key: 'clone',
    title: t('ttsServices.pathCloneTitle'),
    desc: t('ttsServices.pathCloneDesc'),
    action: t('ttsServices.pathCloneAction'),
    ready: voices.length > 0,
    onGo: voices.length > 0 ? () => onOpenClone(voices[0].id) : onCreateVoice,
  });

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('ttsServices.overviewIntro')}
        </p>
      </div>

      {/* 三类来源概念卡 */}
      <div className="grid gap-3 md:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.key}
            className="flex flex-col gap-2 rounded-lg border p-4"
          >
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                {card.icon}
              </span>
              <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                {card.title}
              </p>
            </div>
            <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
              {card.desc}
            </p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ReadyDot ready={card.ready} />
              {card.stat}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1"
              disabled={!card.onGo}
              onClick={card.onGo}
            >
              {card.action}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>

      {/* 推荐起步路径 */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t('ttsServices.quickStart')}
        </p>
        <div className="divide-y rounded-lg border">
          {paths.map((path, i) => (
            <div key={path.key} className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{path.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {path.desc}
                </p>
              </div>
              {path.ready ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 gap-1 text-success hover:text-success"
                  onClick={path.onGo}
                >
                  <Check className="h-3.5 w-3.5" />
                  {t('ttsServices.pathReady')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1"
                  onClick={path.onGo}
                >
                  {path.action}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

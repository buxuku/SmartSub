/**
 * 「翻译服务」右栏：总览面板（默认落地视图）——免费/AI/传统机翻三类概念卡
 * + 配置状态 + 推荐起步路径 + 更多设置（通读摘要提示词）。与引擎页
 * EngineOverviewPanel、配音服务页 TtsOverviewPanel 同构，统一三个配置页的落地动线。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import {
  ArrowRight,
  Check,
  Gift,
  Sparkles,
  Globe2,
  Pencil,
} from 'lucide-react';
import { cn } from 'lib/utils';
import SummaryPromptDialog from '@/components/resources/SummaryPromptDialog';
import { useSummaryPromptCustomized } from '../../hooks/useSummaryPromptCustomized';

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

export interface TranslationOverviewProps {
  groups: Array<{
    key: 'free' | 'ai' | 'mt';
    configured: number;
    total: number;
    firstId: string | null;
  }>;
  /** 起步路径就绪态 */
  freeReady: boolean;
  aiReady: boolean;
  customCount: number;
  onSelectProvider: (id: string) => void;
  onAddCustom: () => void;
}

const GROUP_ICONS = {
  free: Gift,
  ai: Sparkles,
  mt: Globe2,
} as const;

export default function TranslationOverviewPanel({
  groups,
  freeReady,
  aiReady,
  customCount,
  onSelectProvider,
  onAddCustom,
}: TranslationOverviewProps) {
  const { t } = useTranslation('translateControl');
  const [promptOpen, setPromptOpen] = useState(false);
  const promptEditRef = useRef<HTMLButtonElement>(null);
  const { customized, refresh: refreshPromptCustomized } =
    useSummaryPromptCustomized();

  useEffect(() => {
    void refreshPromptCustomized();
  }, [refreshPromptCustomized]);

  const handlePromptOpenChange = (open: boolean) => {
    setPromptOpen(open);
    // 弹窗关闭时编辑已 flush，刷新「已自定义」徽标
    if (!open) void refreshPromptCustomized();
  };

  const paths = [
    {
      key: 'free',
      title: t('overview.pathFreeTitle'),
      desc: t('overview.pathFreeDesc'),
      action: t('overview.pathFreeAction'),
      ready: freeReady,
      onGo: () => onSelectProvider('autoFree'),
    },
    {
      key: 'ai',
      title: t('overview.pathAiTitle'),
      desc: t('overview.pathAiDesc'),
      action: t('overview.pathAiAction'),
      ready: aiReady,
      onGo: () => onSelectProvider('deepseek'),
    },
    {
      key: 'custom',
      title: t('overview.pathCustomTitle'),
      desc: t('overview.pathCustomDesc'),
      action: t('overview.pathCustomAction'),
      ready: customCount > 0,
      onGo: onAddCustom,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('overview.intro')}
        </p>
      </div>

      {/* 三类来源概念卡 */}
      <div className="grid gap-3 md:grid-cols-3">
        {groups.map((group) => {
          const Icon = GROUP_ICONS[group.key];
          return (
            <div
              key={group.key}
              className="flex flex-col gap-2 rounded-lg border bg-panel-2 p-4"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                  {t(
                    group.key === 'free'
                      ? 'groupFree'
                      : group.key === 'ai'
                        ? 'groupAi'
                        : 'groupMt',
                  )}
                </p>
              </div>
              <p className="flex-1 text-xs leading-relaxed text-muted-foreground">
                {t(`overview.${group.key}Desc`)}
              </p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ReadyDot ready={group.configured > 0} />
                {t('overview.statConfigured', {
                  configured: group.configured,
                  total: group.total,
                })}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={!group.firstId}
                onClick={() => group.firstId && onSelectProvider(group.firstId)}
              >
                {t('overview.view')}
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}
      </div>

      {/* 推荐起步路径 */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t('overview.quickStart')}
        </p>
        <div className="divide-y rounded-lg border">
          {paths.map((path, i) => (
            <div key={path.key} className="flex items-center gap-3 px-3 py-2.5">
              <span className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px]">{path.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {path.desc}
                </p>
              </div>
              {path.ready ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-success hover:text-success"
                  onClick={path.onGo}
                >
                  <Check className="h-3.5 w-3.5" />
                  {t('overview.ready')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
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

      {/* 更多设置：低频项，按需展开，不常驻页面 */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t('overview.moreSettings')}
        </p>
        <div className="rounded-lg border">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-[13px]">
                <span className="truncate">{t('summaryPrompt.title')}</span>
                {customized && (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary">
                    {t('summaryPrompt.customized')}
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {t('overview.summaryPromptDesc')}
              </p>
            </div>
            <Button
              ref={promptEditRef}
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => setPromptOpen(true)}
            >
              <Pencil className="h-3.5 w-3.5" />
              {t('overview.summaryPromptEdit')}
            </Button>
          </div>
        </div>
      </div>

      <SummaryPromptDialog
        open={promptOpen}
        onOpenChange={handlePromptOpenChange}
        returnFocusRef={promptEditRef}
      />
    </div>
  );
}

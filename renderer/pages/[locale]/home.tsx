import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { v4 as uuidv4 } from 'uuid';
import {
  ChevronRight,
  History,
  Keyboard,
  MousePointerClick,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';
import EmptyState from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelHeader } from '@/components/ui/panel';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from 'lib/utils';
import { getTaskTypeBySlug } from 'lib/taskTypes';
import { isProviderConfigured } from 'lib/providerUtils';
import { hasAnyModelAnyEngine } from 'lib/engineModels';
import { isTtsProviderConfigured } from '../../../types/ttsProvider';
import { backendDisplay } from '@/components/settings/gpu/gpuUtils';
import {
  CardDecor,
  DubbingIcon,
  GenerateIcon,
  GenerateTranslateIcon,
  MergeIcon,
  ProofreadIcon,
  TranslateIcon,
} from '@/components/launchpad/TaskIcons';
import WorkItemList from '@/components/launchpad/WorkItemList';
import WorkItemRowsSkeleton from '@/components/launchpad/WorkItemRowsSkeleton';
import EnvReadiness, { type EnvRow } from '@/components/launchpad/EnvReadiness';
import ContinueWork, {
  pickContinueItem,
} from '@/components/launchpad/ContinueWork';
import { getWorkItemStatus, getWorkItemTarget } from 'lib/workItemUtils';
import { isMacPlatform } from 'hooks/useHotkeys';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { useTranslation } from 'next-i18next';
import type { WorkItem } from '../../../types/workItem';

interface CardDef {
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 图标 chip 配色 */
  chip: string;
  /** 角落线条装饰配色 */
  decor: string;
  /** /tasks/[slug] 卡片 */
  slug?: string;
  /** 直达页面卡片 */
  href?: string;
  needsModel?: boolean;
  /** 主推工作流：卡片带品牌色渐变底 */
  featured?: boolean;
}

const CARDS: CardDef[] = [
  {
    key: 'generateTranslate',
    slug: 'generate-translate',
    icon: GenerateTranslateIcon,
    chip: 'bg-gradient-to-br from-indigo-500/20 via-indigo-500/10 to-transparent ring-1 ring-inset ring-indigo-500/20 text-indigo-600 dark:text-indigo-400',
    decor: 'text-indigo-500/[0.09] dark:text-indigo-400/[0.12]',
    needsModel: true,
    featured: true,
  },
  {
    key: 'generate',
    slug: 'generate',
    icon: GenerateIcon,
    chip: 'bg-gradient-to-br from-sky-500/20 via-sky-500/10 to-transparent ring-1 ring-inset ring-sky-500/20 text-sky-600 dark:text-sky-400',
    decor: 'text-sky-500/[0.09] dark:text-sky-400/[0.12]',
    needsModel: true,
  },
  {
    key: 'translate',
    slug: 'translate',
    icon: TranslateIcon,
    chip: 'bg-gradient-to-br from-emerald-500/20 via-emerald-500/10 to-transparent ring-1 ring-inset ring-emerald-500/20 text-emerald-600 dark:text-emerald-400',
    decor: 'text-emerald-500/[0.09] dark:text-emerald-400/[0.12]',
  },
  {
    key: 'proofread',
    href: 'proofread',
    icon: ProofreadIcon,
    chip: 'bg-gradient-to-br from-amber-500/20 via-amber-500/10 to-transparent ring-1 ring-inset ring-amber-500/25 text-amber-600 dark:text-amber-400',
    decor: 'text-amber-500/[0.09] dark:text-amber-400/[0.12]',
  },
  {
    key: 'merge',
    href: 'subtitleMerge',
    icon: MergeIcon,
    chip: 'bg-gradient-to-br from-rose-500/20 via-rose-500/10 to-transparent ring-1 ring-inset ring-rose-500/20 text-rose-600 dark:text-rose-400',
    decor: 'text-rose-500/[0.09] dark:text-rose-400/[0.12]',
  },
  {
    key: 'dubbing',
    href: 'dubbing',
    icon: DubbingIcon,
    chip: 'bg-gradient-to-br from-violet-500/20 via-violet-500/10 to-transparent ring-1 ring-inset ring-violet-500/20 text-violet-600 dark:text-violet-400',
    decor: 'text-violet-500/[0.09] dark:text-violet-400/[0.12]',
  },
];

const NEEDS_PROVIDER_KEYS = new Set(['translate', 'generateTranslate']);

function getCardBlock(
  card: CardDef,
  hasModels: boolean,
  hasProvider: boolean,
): 'model' | 'provider' | null {
  if (card.needsModel && !hasModels) return 'model';
  if (NEEDS_PROVIDER_KEYS.has(card.key) && !hasProvider) return 'provider';
  return null;
}

function resourcesHref(locale: string, block: 'model' | 'provider'): string {
  return block === 'model' ? `/${locale}/engines` : `/${locale}/translation`;
}

export default function LaunchpadPage() {
  const router = useRouter();
  const { locale } = router.query;
  const { t } = useTranslation('launchpad');
  const { t: tTasks } = useTranslation('tasks');
  const [hasModels, setHasModels] = useState(true);
  const [hasProvider, setHasProvider] = useState(true);
  const [providerCount, setProviderCount] = useState(0);
  const [gpuLabel, setGpuLabel] = useState<string | null>(null);
  const [gpuAccel, setGpuAccel] = useState(false);
  const [ttsReady, setTtsReady] = useState(false);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [dragCard, setDragCard] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<WorkItem | null>(null);
  // 问候语/日期/修饰键均依赖运行时环境，挂载后再填充避免水合不一致
  const [greetingKey, setGreetingKey] = useState<string | null>(null);
  const [dateLabel, setDateLabel] = useState('');
  const [modKey, setModKey] = useState('⌘');

  useEffect(() => {
    const hour = new Date().getHours();
    setGreetingKey(
      hour < 5
        ? 'evening'
        : hour < 11
          ? 'morning'
          : hour < 13
            ? 'noon'
            : hour < 18
              ? 'afternoon'
              : 'evening',
    );
    const localeTag = String(locale || 'zh').startsWith('zh')
      ? 'zh-CN'
      : 'en-US';
    setDateLabel(
      new Date().toLocaleDateString(localeTag, {
        month: 'long',
        day: 'numeric',
        weekday: 'long',
      }),
    );
    setModKey(isMacPlatform() ? '⌘' : 'Ctrl');
  }, [locale]);

  useEffect(() => {
    const load = async () => {
      try {
        const [
          systemInfo,
          providers,
          items,
          asrProviders,
          activeBackend,
          ttsProviders,
          ttsModelStatus,
        ] = await Promise.all([
          window?.ipc?.invoke('getSystemInfo', null),
          window?.ipc?.invoke('getTranslationProviders'),
          window?.ipc?.invoke('getWorkItems'),
          window?.ipc?.invoke('getAsrProviders'),
          window?.ipc?.invoke('get-active-backend').catch(() => null),
          window?.ipc?.invoke('getTtsProviders').catch(() => []),
          window?.ipc?.invoke('getTtsModelStatus').catch(() => null),
        ]);
        // 跨引擎就绪判断：任一引擎装有任一模型、或任一云实例已配置即视为已就绪
        setHasModels(hasAnyModelAnyEngine(systemInfo, asrProviders || []));
        const configured = (providers || []).filter((p: any) =>
          isProviderConfigured(p),
        );
        setHasProvider(configured.length > 0);
        setProviderCount(configured.length);
        setWorkItems(items || []);
        if (activeBackend?.backend) {
          setGpuLabel(backendDisplay(activeBackend));
          setGpuAccel(activeBackend.backend !== 'cpu');
        }
        const ttsProviderReady = (ttsProviders || []).some((p: any) =>
          isTtsProviderConfigured(p),
        );
        const ttsModelReady = Boolean(
          ttsModelStatus?.models?.some((m: any) => m.installed),
        );
        setTtsReady(ttsProviderReady || ttsModelReady);
      } catch (error) {
        console.error('Failed to load launchpad data:', error);
      } finally {
        setRecentLoading(false);
      }
    };
    load();
  }, []);

  const cardTarget = (card: CardDef) =>
    card.slug ? `/${locale}/tasks/${card.slug}` : `/${locale}/${card.href}`;

  const projectTarget = (item: WorkItem) =>
    getWorkItemTarget(item, String(locale));

  const handleCardDrop = async (e: React.DragEvent, card: CardDef) => {
    e.preventDefault();
    setDragCard(null);
    if (!card.slug) return;
    const block = getCardBlock(card, hasModels, hasProvider);
    if (block) {
      router.push(resourcesHref(String(locale || 'zh'), block));
      return;
    }
    const typeDef = getTaskTypeBySlug(card.slug);
    if (!typeDef) return;

    const paths: string[] = [];
    const droppedFiles = e.dataTransfer.files;
    for (let i = 0; i < droppedFiles.length; i++) {
      // Electron 32+ 移除 File.path，优先 webUtils；旧 preload 场景回退 .path
      const filePath =
        window?.ipc?.getPathForFile?.(droppedFiles[i]) ??
        (droppedFiles[i] as any).path;
      if (filePath) {
        paths.push(filePath);
      }
    }
    if (!paths.length) {
      router.push(cardTarget(card));
      return;
    }

    const dropped = await window?.ipc?.invoke('getDroppedFiles', {
      files: paths,
      taskType: typeDef.accepts === 'subtitle' ? 'translate' : 'media',
    });
    if (!dropped?.length) {
      router.push(cardTarget(card));
      return;
    }
    // 拖放即开新任务工程
    const id = uuidv4();
    await window?.ipc?.invoke('saveTaskProject', {
      id,
      taskType: typeDef.taskType,
      files: dropped,
    });
    router.push(`/${locale}/tasks/${card.slug}?project=${id}`);
  };

  const startRename = (item: WorkItem) => {
    setEditingId(item.id);
    setNameDraft(item.name || '');
  };

  const commitRename = async (item: WorkItem) => {
    setEditingId(null);
    const name = nameDraft.trim();
    if (!name || name === item.name) return;
    const saved = await window?.ipc?.invoke('renameWorkItem', {
      id: item.id,
      name,
    });
    if (saved) {
      setWorkItems((prev) =>
        prev.map((entry) =>
          entry.id === item.id ? { ...entry, name: saved.name } : entry,
        ),
      );
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await window?.ipc?.invoke('deleteWorkItem', deleteTarget.id);
    setWorkItems((prev) =>
      prev.filter((entry) => entry.id !== deleteTarget.id),
    );
    setDeleteTarget(null);
  };

  const localeStr = String(locale || 'zh');
  // 面板内部自适应填满，最多渲染 30 条防止超长列表拖慢首页
  const previewWorkItems = workItems.slice(0, 30);
  const continueItem = pickContinueItem(workItems);

  const workItemStats = useMemo(() => {
    let running = 0;
    let done = 0;
    for (const item of workItems) {
      const status = getWorkItemStatus(item);
      if (status === 'running') running += 1;
      if (status === 'done') done += 1;
    }
    return { running, done };
  }, [workItems]);

  const tipRows = [
    { icon: Search, label: t('tips.search'), kbd: `${modKey} K` },
    { icon: MousePointerClick, label: t('tips.drop'), kbd: null },
    { icon: Keyboard, label: t('tips.shortcuts'), kbd: '?' },
    { icon: Settings, label: t('tips.settings'), kbd: `${modKey} ,` },
  ];

  const envRows: EnvRow[] = [
    {
      key: 'model',
      label: t('env.model'),
      ready: hasModels,
      value: hasModels ? t('env.ready') : t('env.notInstalled'),
      action: hasModels ? t('env.manage') : t('env.goConfigure'),
      href: `/${localeStr}/engines`,
    },
    {
      key: 'gpu',
      label: t('env.gpu'),
      ready: gpuAccel,
      value: gpuLabel
        ? gpuAccel
          ? t('env.gpuOn', { backend: gpuLabel })
          : t('env.cpuMode')
        : t('env.notDetected'),
      action: t('env.detail'),
      href: `/${localeStr}/engines`,
    },
    {
      key: 'translation',
      label: t('env.translation'),
      ready: hasProvider,
      value: hasProvider
        ? t('env.configuredCount', { count: providerCount })
        : t('env.notConfigured'),
      action: hasProvider ? t('env.manage') : t('env.goConfigure'),
      href: `/${localeStr}/translation`,
    },
    {
      key: 'voice',
      label: t('env.voice'),
      ready: ttsReady,
      value: ttsReady ? t('env.ready') : t('env.notConfigured'),
      action: ttsReady ? t('env.manage') : t('env.goConfigure'),
      href: `/${localeStr}/ttsServices`,
    },
  ];

  return (
    <div className="h-full overflow-auto">
      {/* min-h-full + flex：内容短时拉伸填满视口（消除页面级底部空白），内容长时自然滚动 */}
      <div className="flex min-h-full flex-col gap-2.5 p-3">
        {/* 问候行：时间问候 + 日期 ｜ 任务统计 chips（首页仪表盘的「人味」层） */}
        <div className="flex flex-none flex-wrap items-end justify-between gap-2 px-1 pt-0.5">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-tight tracking-tight">
              {greetingKey ? t(`hero.${greetingKey}`) : '\u00A0'}
            </h1>
            <p className="mt-0.5 text-xs text-faint">
              {dateLabel}
              {dateLabel ? ' · ' : ''}
              {t('subtitle')}
            </p>
          </div>
          <div className="flex flex-none flex-wrap items-center gap-1.5">
            <span className="tnum flex h-6 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-[11px] text-muted-foreground">
              <History className="h-3 w-3 text-faint" />
              {t('hero.statTasks', { count: workItems.length })}
            </span>
            {workItemStats.running > 0 && (
              <span className="tnum flex h-6 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/[0.07] px-2.5 text-[11px] font-medium text-primary">
                <span className="h-[6px] w-[6px] animate-pulse rounded-full bg-primary" />
                {t('hero.statRunning', { count: workItemStats.running })}
              </span>
            )}
            {workItemStats.done > 0 && (
              <span className="tnum flex h-6 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-[11px] text-muted-foreground">
                <span className="h-[6px] w-[6px] rounded-full bg-success" />
                {t('hero.statDone', { count: workItemStats.done })}
              </span>
            )}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 items-stretch gap-2.5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-2.5">
            <Panel className="flex-none">
              <PanelHeader title={t('startPanel.title')} />
              <div className="grid gap-2 p-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {CARDS.map((card) => {
                  const Icon = card.icon;
                  const droppable = Boolean(card.slug);
                  const block = getCardBlock(card, hasModels, hasProvider);
                  const href = block
                    ? resourcesHref(localeStr, block)
                    : cardTarget(card);
                  return (
                    <Link
                      key={card.key}
                      href={href}
                      className={cn(
                        'group relative overflow-hidden rounded-md border bg-panel-2 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_6px_16px_-6px_rgba(22,104,220,0.25)] dark:hover:shadow-[0_6px_20px_-6px_rgba(0,0,0,0.55)]',
                        card.featured &&
                          !block &&
                          'border-primary/25 bg-gradient-to-br from-primary/[0.08] via-primary/[0.04] to-transparent',
                        dragCard === card.key &&
                          'border-2 border-dashed border-primary bg-primary/5',
                        block &&
                          'border-warning/40 bg-warning/[0.04] hover:border-warning/60',
                      )}
                      onDragOver={
                        droppable
                          ? (e) => {
                              e.preventDefault();
                              setDragCard(card.key);
                            }
                          : undefined
                      }
                      onDragLeave={
                        droppable
                          ? (e) => {
                              e.preventDefault();
                              setDragCard(null);
                            }
                          : undefined
                      }
                      onDrop={
                        droppable ? (e) => handleCardDrop(e, card) : undefined
                      }
                    >
                      <CardDecor
                        className={cn(
                          'pointer-events-none absolute right-0 top-0 h-20 w-20 transition-transform duration-300 group-hover:scale-110',
                          card.decor,
                        )}
                      />
                      {card.needsModel && !hasModels && (
                        <Badge
                          variant="outline"
                          className="absolute right-2.5 top-2.5 border-warning/40 bg-card text-[10px] text-warning"
                        >
                          {t('needsModelBadge')}
                        </Badge>
                      )}
                      <div
                        className={cn(
                          'mb-2.5 inline-flex h-9 w-9 items-center justify-center rounded-lg',
                          card.chip,
                        )}
                      >
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="text-[13px] font-semibold">
                        {dragCard === card.key
                          ? t('dropHint')
                          : t(`card.${card.key}`)}
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-faint">
                        {t(`card.${card.key}Desc`)}
                      </p>
                      {block === 'model' && (
                        <p className="mt-1.5 text-[11.5px] font-medium text-primary">
                          {t('banner.noModelCta')} →
                        </p>
                      )}
                      {block === 'provider' && (
                        <p className="mt-1.5 text-[11.5px] font-medium text-primary">
                          {t('banner.noProviderCta')} →
                        </p>
                      )}
                    </Link>
                  );
                })}
              </div>
            </Panel>

            <Panel className="min-h-[240px] flex-1">
              <PanelHeader
                title={t('recentTasks')}
                meta={
                  workItems.length > 0 ? (
                    <Badge variant="secondary" className="tnum">
                      {workItems.length}
                    </Badge>
                  ) : undefined
                }
                actions={
                  workItems.length > 0 ? (
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/${localeStr}/recent-tasks`}>
                        {t('recent.viewAllPage', { count: workItems.length })}
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  ) : undefined
                }
              />
              {recentLoading ? (
                <div className="p-2.5">
                  <WorkItemRowsSkeleton rows={3} />
                </div>
              ) : workItems.length === 0 ? (
                /* 空态吃满面板高度：居中呈现，消除面板内死白 */
                <div className="flex flex-1 items-stretch p-2.5">
                  <EmptyState
                    icon={History}
                    title={t('noRecentTasks')}
                    description={t('noRecentTasksHint')}
                    className="flex-1"
                  />
                </div>
              ) : (
                <>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <WorkItemList
                      flush
                      items={previewWorkItems}
                      locale={localeStr}
                      editingId={editingId}
                      nameDraft={nameDraft}
                      onNameDraftChange={setNameDraft}
                      onStartRename={startRename}
                      onCommitRename={commitRename}
                      onCancelRename={() => setEditingId(null)}
                      onDelete={setDeleteTarget}
                      onOpen={(item) => router.push(projectTarget(item))}
                      tLaunchpad={t}
                      tTasks={tTasks}
                    />
                  </div>
                  {/* 面板底缘收口：固定提示线，避免行数少时下缘悬空 */}
                  <div className="mt-auto flex flex-none items-center gap-1.5 border-t border-border px-3 py-[7px] text-[11px] text-faint">
                    <MousePointerClick className="h-3 w-3" />
                    {t('recent.footerHint')}
                  </div>
                </>
              )}
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-2.5">
            <EnvReadiness
              title={t('env.title')}
              readyBadge={hasModels ? t('env.canWork') : null}
              rows={envRows}
            />
            {continueItem && (
              <ContinueWork
                item={continueItem}
                locale={localeStr}
                t={t}
                tLaunchpad={t}
                tTasks={tTasks}
              />
            )}
            {/* 快速上手：右栏弹性收尾模块，把剩余高度吃掉（消除右栏底部空白） */}
            <Panel className="min-h-[150px] flex-1">
              <PanelHeader title={t('tips.title')} />
              <div className="flex flex-1 flex-col justify-evenly gap-0.5 px-1.5 py-1.5">
                {tipRows.map((tip) => {
                  const TipIcon = tip.icon;
                  return (
                    <div
                      key={tip.label}
                      className="flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[12.5px] transition-colors hover:bg-accent/60"
                    >
                      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <TipIcon className="h-3.5 w-3.5" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {tip.label}
                      </span>
                      {tip.kbd && (
                        <kbd className="tnum flex-none rounded border border-border bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] leading-none text-faint">
                          {tip.kbd}
                        </kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>
        </div>
      </div>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('recent.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('recent.deleteDesc', { name: deleteTarget?.name || '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('recent.cancel')}</AlertDialogCancel>
            <AlertDialogAction className="gap-1.5" onClick={confirmDelete}>
              <Trash2 className="h-4 w-4" />
              {t('recent.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export const getStaticProps = makeStaticProperties([
  'common',
  'launchpad',
  'tasks',
]);

export { getStaticPaths };

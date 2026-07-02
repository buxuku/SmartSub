import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { v4 as uuidv4 } from 'uuid';
import {
  AlertTriangle,
  ChevronRight,
  Download,
  History,
  Languages,
  Trash2,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import {
  CardDecor,
  GenerateIcon,
  GenerateTranslateIcon,
  MergeIcon,
  ProofreadIcon,
  TranslateIcon,
} from '@/components/launchpad/TaskIcons';
import WorkItemList from '@/components/launchpad/WorkItemList';
import WorkItemRowsSkeleton from '@/components/launchpad/WorkItemRowsSkeleton';
import { getWorkItemTarget } from 'lib/workItemUtils';
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
}

const CARDS: CardDef[] = [
  {
    key: 'generateTranslate',
    slug: 'generate-translate',
    icon: GenerateTranslateIcon,
    chip: 'bg-gradient-to-br from-indigo-500/20 via-indigo-500/10 to-transparent ring-1 ring-inset ring-indigo-500/20 text-indigo-600 dark:text-indigo-400',
    decor: 'text-indigo-500/[0.09] dark:text-indigo-400/[0.12]',
    needsModel: true,
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
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [dragCard, setDragCard] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<WorkItem | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [systemInfo, providers, items, asrProviders] = await Promise.all([
          window?.ipc?.invoke('getSystemInfo', null),
          window?.ipc?.invoke('getTranslationProviders'),
          window?.ipc?.invoke('getWorkItems'),
          window?.ipc?.invoke('getAsrProviders'),
        ]);
        // 跨引擎就绪判断：任一引擎装有任一模型、或任一云实例已配置即视为已就绪
        setHasModels(hasAnyModelAnyEngine(systemInfo, asrProviders || []));
        setHasProvider(
          (providers || []).some((p: any) => isProviderConfigured(p)),
        );
        setWorkItems(items || []);
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
  const previewWorkItems = workItems.slice(0, 5);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 space-y-6">
        <PageHeader title={t('title')} description={t('subtitle')} />

        {!hasModels && (
          <div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 flex-wrap">
            <AlertTriangle className="h-4 w-4 text-warning flex-shrink-0" />
            <p className="text-sm min-w-0 flex-1">{t('banner.noModel')}</p>
            <Button asChild size="sm" className="h-8 flex-shrink-0 gap-1.5">
              <Link href={`/${locale}/engines`}>
                <Download className="h-4 w-4" />
                {t('banner.noModelCta')}
              </Link>
            </Button>
          </div>
        )}
        {hasModels && !hasProvider && (
          <div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 flex-wrap">
            <AlertTriangle className="h-4 w-4 text-warning flex-shrink-0" />
            <p className="text-sm min-w-0 flex-1">{t('banner.noProvider')}</p>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="h-8 flex-shrink-0 gap-1.5"
            >
              <Link href={`/${locale}/translation`}>
                <Languages className="h-4 w-4" />
                {t('banner.noProviderCta')}
              </Link>
            </Button>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                  'group relative overflow-hidden rounded-lg border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md',
                  dragCard === card.key &&
                    'border-2 border-dashed border-primary bg-muted/50',
                  block &&
                    'border-warning/40 hover:border-warning/60 bg-warning/[0.03]',
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
                onDrop={droppable ? (e) => handleCardDrop(e, card) : undefined}
              >
                <CardDecor
                  className={cn(
                    'pointer-events-none absolute right-0 top-0 h-24 w-24 transition-transform duration-300 group-hover:scale-110',
                    card.decor,
                  )}
                />
                {card.needsModel && !hasModels && (
                  <Badge
                    variant="outline"
                    className="absolute right-3 top-3 text-[10px] px-1.5 py-0 border-warning/40 text-warning bg-card"
                  >
                    {t('needsModelBadge')}
                  </Badge>
                )}
                <div
                  className={cn(
                    'mb-3 inline-flex h-11 w-11 items-center justify-center rounded-lg',
                    card.chip,
                  )}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <div className="text-sm font-semibold">
                  {dragCard === card.key
                    ? t('dropHint')
                    : t(`card.${card.key}`)}
                </div>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  {t(`card.${card.key}Desc`)}
                </p>
                {block === 'model' && (
                  <p className="mt-2 text-xs font-medium text-primary">
                    {t('banner.noModelCta')} →
                  </p>
                )}
                {block === 'provider' && (
                  <p className="mt-2 text-xs font-medium text-primary">
                    {t('banner.noProviderCta')} →
                  </p>
                )}
              </Link>
            );
          })}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {t('recentTasks')}
            </h2>
            {workItems.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                asChild
              >
                <Link href={`/${localeStr}/recent-tasks`}>
                  {t('recent.viewAllPage', { count: workItems.length })}
                  <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
          </div>
          {recentLoading ? (
            <WorkItemRowsSkeleton rows={3} />
          ) : workItems.length === 0 ? (
            <EmptyState
              icon={History}
              title={t('noRecentTasks')}
              description={t('noRecentTasksHint')}
            />
          ) : (
            <WorkItemList
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
          )}
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

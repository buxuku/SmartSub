import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { v4 as uuidv4 } from 'uuid';
import { AlertTriangle, History, Pencil, Search, Trash2 } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import {
  getTaskTypeBySlug,
  getTaskTypeByValue,
  type TaskTypeDef,
} from 'lib/taskTypes';
import { isProviderConfigured } from 'lib/providerUtils';
import {
  getFileStages,
  getStageStatus,
  isFileDone,
  hasFileError,
} from '@/components/tasks/stageUtils';
import {
  CardDecor,
  GenerateIcon,
  GenerateTranslateIcon,
  MergeIcon,
  ProofreadIcon,
  TranslateIcon,
} from '@/components/launchpad/TaskIcons';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import { useTranslation } from 'next-i18next';

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

type RecentStatus = 'waiting' | 'running' | 'done' | 'error';

// 四态状态点：等待灰 / 运行品牌色 / 成功绿 / 失败红
const STATUS_DOT: Record<RecentStatus, string> = {
  waiting: 'bg-muted-foreground/40',
  running: 'bg-primary animate-pulse',
  done: 'bg-success',
  error: 'bg-destructive',
};

function getProjectTypeDef(project: any): TaskTypeDef {
  return (
    getTaskTypeByValue(project?.taskType) ||
    getTaskTypeBySlug('generate-translate')
  );
}

/** 工程整体状态：有进行中 > 有错误 > 全部完成 > 等待 */
function getProjectStatus(project: any): RecentStatus {
  const typeDef = getProjectTypeDef(project);
  const files: any[] = project?.files || [];
  if (!files.length) return 'waiting';
  let anyLoading = false;
  let anyError = false;
  let allDone = true;
  for (const file of files) {
    // 工程状态只由 taskType 单源推导，不随全局配置漂移 (P1#35)
    const stages = getFileStages(file, typeDef, undefined);
    if (stages.some((s) => getStageStatus(file, s.key) === 'loading')) {
      anyLoading = true;
    }
    if (hasFileError(file, stages)) anyError = true;
    if (!isFileDone(file, stages)) allDone = false;
  }
  if (anyLoading) return 'running';
  if (anyError) return 'error';
  if (allDone) return 'done';
  return 'waiting';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function LaunchpadPage() {
  const router = useRouter();
  const { locale } = router.query;
  const { t } = useTranslation('launchpad');
  const { t: tTasks } = useTranslation('tasks');
  const [hasModels, setHasModels] = useState(true);
  const [hasProvider, setHasProvider] = useState(true);
  const [projects, setProjects] = useState<any[]>([]);
  const [dragCard, setDragCard] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [recentQuery, setRecentQuery] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const [systemInfo, providers, taskProjects, settings] =
          await Promise.all([
            window?.ipc?.invoke('getSystemInfo', null),
            window?.ipc?.invoke('getTranslationProviders'),
            window?.ipc?.invoke('getTaskProjects'),
            window?.ipc?.invoke('getSettings'),
          ]);
        const useLocalWhisper = settings?.useLocalWhisper || false;
        setHasModels(
          useLocalWhisper || (systemInfo?.modelsInstalled?.length ?? 0) > 0,
        );
        setHasProvider(
          (providers || []).some((p: any) => isProviderConfigured(p)),
        );
        setProjects(taskProjects || []);
      } catch (error) {
        console.error('Failed to load launchpad data:', error);
      }
    };
    load();
  }, []);

  const cardTarget = (card: CardDef) =>
    card.slug ? `/${locale}/tasks/${card.slug}` : `/${locale}/${card.href}`;

  const projectTarget = (project: any) =>
    `/${locale}/tasks/${getProjectTypeDef(project).slug}?project=${project.id}`;

  const handleCardDrop = async (e: React.DragEvent, card: CardDef) => {
    e.preventDefault();
    setDragCard(null);
    if (!card.slug) return;
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

  const startRename = (project: any) => {
    setEditingId(project.id);
    setNameDraft(project.name || '');
  };

  const commitRename = async (project: any) => {
    setEditingId(null);
    const name = nameDraft.trim();
    if (!name || name === project.name) return;
    const saved = await window?.ipc?.invoke('renameTaskProject', {
      id: project.id,
      name,
    });
    if (saved) {
      setProjects((prev) =>
        prev.map((p) => (p.id === project.id ? { ...p, name: saved.name } : p)),
      );
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await window?.ipc?.invoke('deleteTaskProject', deleteTarget.id);
    setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
    setDeleteTarget(null);
  };

  const toggleRecentExpanded = () => {
    setRecentExpanded((prev) => {
      if (prev) setRecentQuery('');
      return !prev;
    });
  };

  // 收起态只取前 8 条；展开态显示全量并支持按名称过滤
  const normalizedQuery = recentQuery.trim().toLowerCase();
  const visibleProjects = recentExpanded
    ? normalizedQuery
      ? projects.filter((p) =>
          (p.name || '').toLowerCase().includes(normalizedQuery),
        )
      : projects
    : projects.slice(0, 8);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 space-y-8">
        <PageHeader title={t('title')} description={t('subtitle')} />

        {!hasModels && (
          <div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 flex-wrap">
            <AlertTriangle className="h-4 w-4 text-warning flex-shrink-0" />
            <p className="text-sm min-w-0 flex-1">{t('banner.noModel')}</p>
            <Button asChild size="sm" className="h-8 flex-shrink-0">
              <Link href={`/${locale}/resources?tab=models`}>
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
              className="h-8 flex-shrink-0"
            >
              <Link href={`/${locale}/resources?tab=providers`}>
                {t('banner.noProviderCta')}
              </Link>
            </Button>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((card) => {
            const Icon = card.icon;
            const droppable = Boolean(card.slug);
            return (
              <Link
                key={card.key}
                href={cardTarget(card)}
                className={cn(
                  'group relative overflow-hidden rounded-xl border bg-card p-4 transition-all hover:shadow-md hover:-translate-y-0.5',
                  dragCard === card.key &&
                    'border-2 border-dashed border-primary bg-muted/50',
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
                    'mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl',
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
              </Link>
            );
          })}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {t('recentTasks')}
            </h2>
            {projects.length > 8 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-foreground"
                onClick={toggleRecentExpanded}
              >
                {recentExpanded
                  ? t('recent.collapse')
                  : t('recent.viewAll', { count: projects.length })}
              </Button>
            )}
          </div>
          {recentExpanded && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={recentQuery}
                onChange={(e) => setRecentQuery(e.target.value)}
                placeholder={t('recent.searchPlaceholder')}
                className="h-8 pl-9 text-sm"
              />
            </div>
          )}
          {projects.length === 0 ? (
            <EmptyState
              icon={History}
              title={t('noRecentTasks')}
              description={t('noRecentTasksHint')}
            />
          ) : visibleProjects.length === 0 ? (
            <p className="rounded-xl border px-4 py-6 text-center text-sm text-muted-foreground">
              {t('recent.noMatch')}
            </p>
          ) : (
            <div className="rounded-xl border divide-y">
              {visibleProjects.map((project) => {
                const status = getProjectStatus(project);
                const typeDef = getProjectTypeDef(project);
                const editing = editingId === project.id;
                return (
                  <div
                    key={project.id}
                    className="group flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors cursor-pointer"
                    onClick={() => {
                      if (!editing) router.push(projectTarget(project));
                    }}
                  >
                    <span
                      className={cn(
                        'h-2 w-2 rounded-full flex-shrink-0',
                        STATUS_DOT[status],
                      )}
                    />
                    {editing ? (
                      <Input
                        autoFocus
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(project);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={() => commitRename(project)}
                        className="h-7 text-xs min-w-0 flex-1"
                      />
                    ) : (
                      <span className="truncate text-sm min-w-0 flex-1">
                        {project.name}
                      </span>
                    )}
                    <span className="hidden sm:inline text-[11px] text-muted-foreground rounded bg-muted px-1.5 py-0.5 flex-shrink-0">
                      {tTasks(`pageTitle.${typeDef.slug}`)}
                    </span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {t('fileCount', { count: project.files?.length || 0 })}
                    </span>
                    <span className="hidden md:inline text-xs text-muted-foreground/70 tabular-nums flex-shrink-0">
                      {formatTime(project.updatedAt)}
                    </span>
                    <span className="text-xs text-muted-foreground flex-shrink-0 w-12 text-right">
                      {t(`status.${status}`)}
                    </span>
                    <span
                      className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t('recent.rename')}
                        onClick={() => startRename(project)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        aria-label={t('recent.delete')}
                        onClick={() => setDeleteTarget(project)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </div>
                );
              })}
            </div>
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
            <AlertDialogAction onClick={confirmDelete}>
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

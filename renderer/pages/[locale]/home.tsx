import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { v4 as uuidv4 } from 'uuid';
import {
  BookMarked,
  ChevronRight,
  Clapperboard,
  History,
  Keyboard,
  MousePointerClick,
  Pencil,
  Plus,
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
import { Input } from '@/components/ui/input';
import { cn } from 'lib/utils';
import { getTaskTypeBySlug } from 'lib/taskTypes';
import { isProviderConfigured } from 'lib/providerUtils';
import { hasAnyModelAnyEngine } from 'lib/engineModels';
import {
  BUILTIN_RECIPES,
  builtinCardKey,
  recipeBlock,
  recipeBlockHref,
  recipeSlug,
  recipeStageKeys,
  recipeTarget,
  WIZARD_DROP_KEY,
} from 'lib/recipes';
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
import type { TaskRecipe } from '../../../types/recipe';

interface RecipeVisual {
  icon: React.ComponentType<{ className?: string }>;
  /** 图标 chip 配色 */
  chip: string;
  /** 角落线条装饰配色 */
  decor: string;
  /** 主推工作流：卡片带品牌色渐变底 */
  featured?: boolean;
}

/** 内置配方卡的视觉映射（沿用旧卡片配色，深链习惯不破坏） */
const BUILTIN_VISUALS: Record<string, RecipeVisual> = {
  'builtin-pipeline': {
    icon: Clapperboard,
    chip: 'bg-gradient-to-br from-fuchsia-500/20 via-fuchsia-500/10 to-transparent ring-1 ring-inset ring-fuchsia-500/20 text-fuchsia-600 dark:text-fuchsia-400',
    decor: 'text-fuchsia-500/[0.09] dark:text-fuchsia-400/[0.12]',
    featured: true,
  },
  'builtin-generate-translate': {
    icon: GenerateTranslateIcon,
    chip: 'bg-gradient-to-br from-indigo-500/20 via-indigo-500/10 to-transparent ring-1 ring-inset ring-indigo-500/20 text-indigo-600 dark:text-indigo-400',
    decor: 'text-indigo-500/[0.09] dark:text-indigo-400/[0.12]',
    featured: true,
  },
  'builtin-generate': {
    icon: GenerateIcon,
    chip: 'bg-gradient-to-br from-sky-500/20 via-sky-500/10 to-transparent ring-1 ring-inset ring-sky-500/20 text-sky-600 dark:text-sky-400',
    decor: 'text-sky-500/[0.09] dark:text-sky-400/[0.12]',
  },
  'builtin-translate': {
    icon: TranslateIcon,
    chip: 'bg-gradient-to-br from-emerald-500/20 via-emerald-500/10 to-transparent ring-1 ring-inset ring-emerald-500/20 text-emerald-600 dark:text-emerald-400',
    decor: 'text-emerald-500/[0.09] dark:text-emerald-400/[0.12]',
  },
};

/** 用户配方卡的统一视觉 */
const USER_RECIPE_VISUAL: RecipeVisual = {
  icon: BookMarked,
  chip: 'bg-gradient-to-br from-amber-500/20 via-amber-500/10 to-transparent ring-1 ring-inset ring-amber-500/25 text-amber-600 dark:text-amber-400',
  decor: 'text-amber-500/[0.09] dark:text-amber-400/[0.12]',
};

/** 工具行：单文件精修工作台入口（与配方卡视觉分层） */
const TOOLS: Array<{
  key: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: 'proofread', href: 'proofread', icon: ProofreadIcon },
  { key: 'merge', href: 'subtitleMerge', icon: MergeIcon },
  { key: 'dubbing', href: 'dubbing', icon: DubbingIcon },
];

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
  const [userRecipes, setUserRecipes] = useState<TaskRecipe[]>([]);
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null);
  const [recipeNameDraft, setRecipeNameDraft] = useState('');
  const [deleteRecipeTarget, setDeleteRecipeTarget] =
    useState<TaskRecipe | null>(null);
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
          recipes,
        ] = await Promise.all([
          window?.ipc?.invoke('getSystemInfo', null),
          window?.ipc?.invoke('getTranslationProviders'),
          window?.ipc?.invoke('getWorkItems'),
          window?.ipc?.invoke('getAsrProviders'),
          window?.ipc?.invoke('get-active-backend').catch(() => null),
          window?.ipc?.invoke('getTtsProviders').catch(() => []),
          window?.ipc?.invoke('getTtsModelStatus').catch(() => null),
          window?.ipc?.invoke('recipes:list').catch(() => []),
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
        setUserRecipes(Array.isArray(recipes) ? recipes : []);
      } catch (error) {
        console.error('Failed to load launchpad data:', error);
      } finally {
        setRecentLoading(false);
      }
    };
    load();
  }, []);

  const projectTarget = (item: WorkItem) =>
    getWorkItemTarget(item, String(locale));

  const readiness = { hasModels, hasProvider, ttsReady };

  const collectDropPaths = (e: React.DragEvent): string[] => {
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
    return paths;
  };

  /** 双类型解析拖放路径（媒体+字幕，含目录展开）：向导已支持混合配对输入 */
  const resolveDroppedBothKinds = async (paths: string[]) => {
    const [media, subtitles] = await Promise.all([
      window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: 'media',
      }),
      window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: 'translate',
      }),
    ]);
    return [...(media ?? []), ...(subtitles ?? [])];
  };

  const handleRecipeDrop = async (e: React.DragEvent, recipe: TaskRecipe) => {
    e.preventDefault();
    setDragCard(null);
    const loc = String(locale || 'zh');
    const block = recipeBlock(recipe, readiness);
    if (block) {
      router.push(recipeBlockHref(loc, block));
      return;
    }
    const target = recipeTarget(recipe, loc);
    const paths = collectDropPaths(e);
    if (!paths.length) {
      router.push(target);
      return;
    }
    const slug = recipeSlug(recipe);
    if (slug) {
      // 纯字幕配方：拖放直建工程（现状机制，功能面零回归；按配方输入类型过滤）
      const dropped = await window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: recipe.accepts === 'subtitle' ? 'translate' : 'media',
      });
      if (!dropped?.length) {
        router.push(target);
        return;
      }
      const typeDef = getTaskTypeBySlug(slug)!;
      const id = uuidv4();
      await window?.ipc?.invoke('saveTaskProject', {
        id,
        taskType: typeDef.taskType,
        files: dropped,
      });
      router.push(`/${loc}/tasks/${slug}?project=${id}`);
      return;
    }
    // 含附加阶段（走向导）：媒体+字幕都收（向导自动配对），经 sessionStorage 交接
    const dropped = await resolveDroppedBothKinds(paths);
    if (dropped.length) {
      try {
        sessionStorage.setItem(WIZARD_DROP_KEY, JSON.stringify(dropped));
      } catch {
        /* ignore */
      }
    }
    router.push(target);
  };

  // 「＋ 自定义流程」卡：拖放文件进空白向导（媒体+字幕混合可配对）
  const handleCustomDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragCard(null);
    const target = `/${String(locale || 'zh')}/tasks/new`;
    const paths = collectDropPaths(e);
    if (paths.length) {
      const dropped = await resolveDroppedBothKinds(paths);
      if (dropped.length) {
        try {
          sessionStorage.setItem(WIZARD_DROP_KEY, JSON.stringify(dropped));
        } catch {
          /* ignore */
        }
      }
    }
    router.push(target);
  };

  const startRecipeRename = (recipe: TaskRecipe) => {
    setEditingRecipeId(recipe.id);
    setRecipeNameDraft(recipe.name);
  };

  const commitRecipeRename = async (recipe: TaskRecipe) => {
    setEditingRecipeId(null);
    const name = recipeNameDraft.trim();
    if (!name || name === recipe.name) return;
    const saved = await window?.ipc?.invoke('recipes:rename', {
      id: recipe.id,
      name,
    });
    if (saved) {
      setUserRecipes((prev) =>
        prev.map((r) => (r.id === recipe.id ? { ...r, name: saved.name } : r)),
      );
    }
  };

  const confirmDeleteRecipe = async () => {
    if (!deleteRecipeTarget) return;
    await window?.ipc?.invoke('recipes:delete', deleteRecipeTarget.id);
    setUserRecipes((prev) =>
      prev.filter((r) => r.id !== deleteRecipeTarget.id),
    );
    setDeleteRecipeTarget(null);
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
  // 列表只在面板内滚动，不撑高页面；30 条为渲染上限，防止超长列表拖慢首页
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
      {/* 窄屏：min-h-full，内容长时页面自然滚动；xl 双栏：h-full 锁定视口高度，
          最近任务在面板内滚动，右栏不再被超长列表撑高 */}
      <div className="flex min-h-full flex-col gap-2.5 p-3 xl:h-full">
        {/* 问候行：时间问候 + 日期 ｜ 任务统计 chips（首页仪表盘的「人味」层） */}
        <div className="flex flex-none flex-wrap items-end justify-between gap-2 px-1 pt-0.5">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-tight tracking-tight">
              {greetingKey ? t(`hero.${greetingKey}`) : '\u00A0'}
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
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

        {/* xl 显式 minmax(0,1fr) 行：行高锁定为剩余视口高度（默认隐式行按内容撑高，
            长列表会把两栏一起拉长）；两列 min-h-0 允许随行收缩 */}
        <div className="grid min-h-0 flex-1 items-stretch gap-2.5 xl:grid-cols-[minmax(0,1fr)_340px] xl:grid-rows-[minmax(0,1fr)]">
          <div className="flex min-h-0 min-w-0 flex-col gap-2.5">
            <Panel className="flex-none">
              <PanelHeader title={t('startPanel.title')} />
              <div className="grid gap-2 p-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {[...BUILTIN_RECIPES, ...userRecipes].map((recipe) => {
                  const visual =
                    (recipe.builtin && BUILTIN_VISUALS[recipe.id]) ||
                    USER_RECIPE_VISUAL;
                  const Icon = visual.icon;
                  const block = recipeBlock(recipe, readiness);
                  const href = block
                    ? recipeBlockHref(localeStr, block)
                    : recipeTarget(recipe, localeStr);
                  const label = recipe.builtin
                    ? t(`card.${builtinCardKey(recipe.id)}`)
                    : recipe.name;
                  const desc = recipe.builtin
                    ? t(`card.${builtinCardKey(recipe.id)}Desc`)
                    : recipeStageKeys(recipe)
                        .map((key) => t(`pipeline.${key}`))
                        .join(' · ');
                  const editing = editingRecipeId === recipe.id;
                  return (
                    <Link
                      key={recipe.id}
                      href={href}
                      className={cn(
                        'group relative overflow-hidden rounded-md border bg-panel-2 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_6px_16px_-6px_rgba(22,104,220,0.25)] dark:hover:shadow-[0_6px_20px_-6px_rgba(0,0,0,0.55)]',
                        visual.featured &&
                          !block &&
                          'border-primary/25 bg-gradient-to-br from-primary/[0.08] via-primary/[0.04] to-transparent',
                        dragCard === recipe.id &&
                          'border-2 border-dashed border-primary bg-primary/5',
                        block &&
                          'border-warning/40 bg-warning/[0.04] hover:border-warning/60',
                      )}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragCard(recipe.id);
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault();
                        setDragCard(null);
                      }}
                      onDrop={(e) => handleRecipeDrop(e, recipe)}
                    >
                      <CardDecor
                        className={cn(
                          'pointer-events-none absolute right-0 top-0 h-20 w-20 transition-transform duration-300 group-hover:scale-110',
                          visual.decor,
                        )}
                      />
                      {block === 'model' && (
                        <Badge
                          variant="outline"
                          className="absolute right-2.5 top-2.5 border-warning/40 bg-card text-warning group-hover:opacity-0"
                        >
                          {t('needsModelBadge')}
                        </Badge>
                      )}
                      {/* 用户配方管理：hover 重命名/删除（内置无） */}
                      {!recipe.builtin && !editing && (
                        <div className="absolute right-2 top-2 z-10 hidden gap-0.5 group-hover:flex">
                          <button
                            type="button"
                            aria-label={t('recipes.rename')}
                            title={t('recipes.rename')}
                            className="rounded-md border border-border bg-card p-1.5 text-muted-foreground shadow-sm hover:text-foreground"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              startRecipeRename(recipe);
                            }}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            aria-label={t('recipes.delete')}
                            title={t('recipes.delete')}
                            className="rounded-md border border-border bg-card p-1.5 text-muted-foreground shadow-sm hover:text-destructive"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDeleteRecipeTarget(recipe);
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                      <div
                        className={cn(
                          'mb-2.5 inline-flex h-9 w-9 items-center justify-center rounded-lg',
                          visual.chip,
                        )}
                      >
                        <Icon className="h-5 w-5" />
                      </div>
                      {editing ? (
                        <Input
                          autoFocus
                          value={recipeNameDraft}
                          onChange={(e) => setRecipeNameDraft(e.target.value)}
                          onClick={(e) => e.preventDefault()}
                          onBlur={() => commitRecipeRename(recipe)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void commitRecipeRename(recipe);
                            }
                            if (e.key === 'Escape') setEditingRecipeId(null);
                          }}
                          className="h-7 text-[13px] font-semibold"
                        />
                      ) : (
                        <div className="truncate text-[13px] font-semibold">
                          {dragCard === recipe.id ? t('dropHint') : label}
                        </div>
                      )}
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {desc}
                      </p>
                      {block && (
                        <p className="mt-1.5 text-[11.5px] font-medium text-primary">
                          {block === 'model'
                            ? t('banner.noModelCta')
                            : block === 'provider'
                              ? t('banner.noProviderCta')
                              : t('banner.noTtsCta')}{' '}
                          →
                        </p>
                      )}
                    </Link>
                  );
                })}
                {/* ＋ 自定义流程：进空白向导，自由组合目标与配置 */}
                <Link
                  key="custom"
                  href={`/${localeStr}/tasks/new`}
                  className={cn(
                    'group relative flex min-h-[110px] flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-panel-2/50 p-3 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.03]',
                    dragCard === 'custom' &&
                      'border-2 border-primary bg-primary/5',
                  )}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragCard('custom');
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setDragCard(null);
                  }}
                  onDrop={handleCustomDrop}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
                    <Plus className="h-5 w-5" />
                  </span>
                  <div className="text-[13px] font-medium">
                    {dragCard === 'custom'
                      ? t('dropHint')
                      : t('recipes.custom')}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t('recipes.customDesc')}
                  </p>
                </Link>
              </div>
              {/* 工具行：单文件精修工作台（与配方卡分层） */}
              <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
                <span className="text-[11px] text-faint">
                  {t('tools.title')}
                </span>
                {TOOLS.map((tool) => {
                  const ToolIcon = tool.icon;
                  return (
                    <Link
                      key={tool.key}
                      href={`/${localeStr}/${tool.href}`}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                    >
                      <ToolIcon className="h-3.5 w-3.5" />
                      {t(`card.${tool.key}`)}
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
                  {/* xl 视口锁高后在面板内滚动；窄屏堆叠时用 max-h 限高，避免长列表撑爆页面 */}
                  <div className="max-h-[420px] min-h-0 flex-1 overflow-y-auto xl:max-h-none">
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

          <div className="flex min-h-0 min-w-0 flex-col gap-2.5">
            {/* flex-none：视口锁高后右栏空间有限时，常显仪表不被压缩，剩余高度全部交给快速上手 */}
            <EnvReadiness
              className="flex-none"
              title={t('env.title')}
              readyBadge={hasModels ? t('env.canWork') : null}
              rows={envRows}
            />
            {continueItem && (
              <ContinueWork
                className="flex-none"
                item={continueItem}
                locale={localeStr}
                t={t}
                tLaunchpad={t}
                tTasks={tTasks}
              />
            )}
            {/* 快速上手：右栏收尾模块，面板边框拉到列底对齐左栏；
                行距固定顶部对齐，面板再高条目也不会被均摊拉稀 */}
            <Panel className="min-h-[150px] flex-1">
              <PanelHeader title={t('tips.title')} />
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-1.5">
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

      <AlertDialog
        open={Boolean(deleteRecipeTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteRecipeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('recipes.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('recipes.deleteDesc', {
                name: deleteRecipeTarget?.name || '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('recipes.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="gap-1.5"
              onClick={confirmDeleteRecipe}
            >
              <Trash2 className="h-4 w-4" />
              {t('recipes.confirmDelete')}
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

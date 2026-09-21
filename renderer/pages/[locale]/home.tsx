import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { v4 as uuidv4 } from 'uuid';
import { toast } from 'sonner';
import GlobalDropOverlay from '@/components/launchpad/GlobalDropOverlay';
import ModelQuickDownloadDialog from '@/components/launchpad/ModelQuickDownloadDialog';
import { taskDraftManager, type TaskDraft } from '@/lib/taskDraftManager';
import {
  appendLaunchpadFiles,
  buildLaunchpadDraft,
} from '@/lib/launchpadDraft';
import { useNavigationGuard } from '@/context/NavigationGuardContext';
import {
  BookMarked,
  ChevronRight,
  Clapperboard,
  CloudDownload,
  FolderOpen,
  History,
  Keyboard,
  Loader2,
  MousePointerClick,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  Upload,
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
import { cn, isSubtitleFile } from 'lib/utils';
import { isManuscriptPath } from 'lib/filePairing';
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

/**
 * 独立工具：单文件精修工作台入口（与配方卡视觉分层）。
 * xl 宽屏在右栏以「工具箱」面板常显；窄屏右栏沉底，回退为开始创作面板底部的工具行。
 */
const TOOLS: Array<{
  key: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** 工具箱面板的图标 chip 配色（沿用配方卡视觉语言，色相与配方卡错开） */
  chip: string;
}> = [
  {
    key: 'download',
    href: 'download',
    icon: CloudDownload,
    chip: 'bg-gradient-to-br from-sky-500/20 via-sky-500/10 to-transparent ring-1 ring-inset ring-sky-500/25 text-sky-600 dark:text-sky-400',
  },
  {
    key: 'proofread',
    href: 'proofread',
    icon: ProofreadIcon,
    chip: 'bg-gradient-to-br from-violet-500/20 via-violet-500/10 to-transparent ring-1 ring-inset ring-violet-500/25 text-violet-600 dark:text-violet-400',
  },
  {
    key: 'merge',
    href: 'subtitleMerge',
    icon: MergeIcon,
    chip: 'bg-gradient-to-br from-rose-500/20 via-rose-500/10 to-transparent ring-1 ring-inset ring-rose-500/25 text-rose-600 dark:text-rose-400',
  },
  {
    key: 'dubbing',
    href: 'dubbing',
    icon: DubbingIcon,
    chip: 'bg-gradient-to-br from-orange-500/20 via-orange-500/10 to-transparent ring-1 ring-inset ring-orange-500/25 text-orange-600 dark:text-orange-400',
  },
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
  const [globalDragging, setGlobalDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const importBusyRef = useRef(false);
  const [importing, setImporting] = useState(false);
  const [quickDownloadOpen, setQuickDownloadOpen] = useState(false);
  const [stagedDraft, setStagedDraft] = useState<TaskDraft | null>(null);
  const [draftError, setDraftError] = useState(false);
  const [pendingImport, setPendingImport] = useState<{
    files: TaskDraft['files'];
    recipe?: TaskRecipe;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<WorkItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
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
          ttsModelStatus?.engineInstalled === true &&
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

  useNavigationGuard('launchpad-draft-storage', {
    isDirty: Boolean(stagedDraft?.files.length && draftError),
    getIsDirty: () =>
      Boolean(stagedDraft?.files.length && taskDraftManager.storageFailed),
    onSave: async () => {
      if (!stagedDraft) return true;
      const saved = taskDraftManager.saveDraft(stagedDraft);
      setDraftError(!saved);
      return saved;
    },
    onDiscard: () => {
      taskDraftManager.clearDraft();
      setStagedDraft(null);
      setDraftError(false);
    },
  });

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

  /** 三类型解析拖放路径（媒体+字幕+参考文稿，含目录展开）：向导已支持混合配对输入 */
  const resolveDroppedBothKinds = async (paths: string[]) => {
    const [media, subtitles, manuscripts] = await Promise.all([
      window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: 'media',
      }),
      window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: 'translate',
      }),
      window?.ipc?.invoke('getDroppedFiles', {
        files: paths,
        taskType: 'manuscript',
      }),
    ]);
    return [...(media ?? []), ...(subtitles ?? []), ...(manuscripts ?? [])];
  };

  const handleGlobalDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragCounterRef.current++;
    setGlobalDragging(true);
  };

  const resetDrag = () => {
    dragCounterRef.current = 0;
    setGlobalDragging(false);
    setDragCard(null);
  };

  const handleGlobalDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      resetDrag();
    }
  };

  const handleGlobalDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setGlobalDragging(true);
    const target = (e.target as Element).closest('[data-drop-recipe]');
    setDragCard(target?.getAttribute('data-drop-recipe') ?? null);
  };

  const continueDraft = async (draft: TaskDraft, installed = false) => {
    setStagedDraft(draft);
    const saved = taskDraftManager.saveDraft(draft);
    setDraftError(!saved);
    if (!saved) return;

    const hasMedia = draft.files.some(
      (file) =>
        !isSubtitleFile(file.filePath.toLowerCase()) &&
        !isManuscriptPath(file.filePath),
    );
    const hasSubtitles = draft.files.some(
      (file) =>
        isSubtitleFile(file.filePath.toLowerCase()) &&
        !isManuscriptPath(file.filePath),
    );
    // Paired inputs bypass ASR; missing translation/TTS is resolved in the draft.
    if (hasMedia && !hasSubtitles && !installed) {
      const [info, providers] = await Promise.all([
        window.ipc.invoke('getSystemInfo', null),
        window.ipc.invoke('getAsrProviders'),
      ]);
      const ready = hasAnyModelAnyEngine(info, providers || []);
      setHasModels(ready);
      if (!ready) {
        setQuickDownloadOpen(true);
        return;
      }
    }
    await router.push(
      `/${localeStr}/tasks/new?draft=${encodeURIComponent(draft.id!)}`,
    );
  };

  const stageImport = async (
    files: TaskDraft['files'],
    recipe?: TaskRecipe,
  ) => {
    const existing = taskDraftManager.getDraft();
    if (existing?.files.length || taskDraftManager.hasUnreadableDraft) {
      setPendingImport({ files, recipe });
      return;
    }
    const defaults = await window.ipc.invoke('getUserConfig');
    await continueDraft(buildLaunchpadDraft(files, defaults || {}, recipe));
  };

  const resolvePendingImport = async (append: boolean) => {
    if (!pendingImport || importBusyRef.current) return;
    importBusyRef.current = true;
    setImporting(true);
    try {
      const existing = taskDraftManager.getDraft();
      if (taskDraftManager.hasUnreadableDraft) {
        if (append || !taskDraftManager.clearDraft()) {
          toast.error(t('globalDrop.storageFailed'));
          return;
        }
      }
      const draft =
        append && existing
          ? appendLaunchpadFiles(existing, pendingImport.files)
          : buildLaunchpadDraft(
              pendingImport.files,
              await window.ipc.invoke('getUserConfig'),
              pendingImport.recipe,
            );
      setPendingImport(null);
      await continueDraft(draft);
    } catch (error) {
      console.error('Failed to continue launchpad draft:', error);
      toast.error(t('globalDrop.failed'));
    } finally {
      importBusyRef.current = false;
      setImporting(false);
    }
  };

  const importPaths = async (paths: string[]) => {
    if (!paths.length) return;
    const dropped = await resolveDroppedBothKinds(paths);
    if (!dropped.length) {
      toast.error(t('globalDrop.unsupported'));
      return;
    }

    await stageImport(dropped);
  };

  const importFiles = async (paths?: string[]) => {
    if (importBusyRef.current || quickDownloadOpen || pendingImport) return;
    importBusyRef.current = true;
    setImporting(true);
    try {
      if (paths) {
        await importPaths(paths);
      } else {
        const result = await window?.ipc?.invoke('selectFiles', {
          type: 'any',
          multiple: true,
          title: t('globalDrop.selectFiles'),
        });
        if (result && !result.canceled) {
          await importPaths(result.filePaths ?? []);
        }
      }
    } catch (error) {
      console.error('Failed to import launchpad files:', error);
      toast.error(t('globalDrop.failed'));
    } finally {
      importBusyRef.current = false;
      setImporting(false);
    }
  };

  const handleGlobalDrop = (e: React.DragEvent) => {
    e.preventDefault();
    resetDrag();
    void importFiles(collectDropPaths(e));
  };

  const handleRecipeDrop = async (e: React.DragEvent, recipe: TaskRecipe) => {
    e.preventDefault();
    e.stopPropagation();
    resetDrag();
    if (
      !e.dataTransfer.types.includes('Files') ||
      importBusyRef.current ||
      quickDownloadOpen ||
      pendingImport
    )
      return;
    const loc = String(locale || 'zh');
    const paths = collectDropPaths(e);
    if (!paths.length) return;
    const block = recipeBlock(recipe, readiness);
    const slug = recipeSlug(recipe);

    importBusyRef.current = true;
    setImporting(true);
    try {
      // 固定任务按输入类型过滤；完整向导仍允许媒体、字幕、文稿混合配对。
      const dropped =
        recipe.accepts === 'subtitle' || slug
          ? ((await window?.ipc?.invoke('getDroppedFiles', {
              files: paths,
              taskType:
                recipe.accepts === 'subtitle'
                  ? 'translate'
                  : 'media-and-manuscript',
            })) ?? [])
          : await resolveDroppedBothKinds(paths);
      if (!dropped.length) {
        toast.error(
          t(
            recipe.accepts === 'subtitle'
              ? 'globalDrop.subtitleRequired'
              : 'globalDrop.unsupported',
          ),
        );
        return;
      }

      if (recipe.builtin && slug && !block) {
        const typeDef = getTaskTypeBySlug(slug)!;
        const id = uuidv4();
        const saved = await window?.ipc?.invoke('saveTaskProject', {
          id,
          taskType: typeDef.taskType,
          files: dropped,
        });
        if (saved?.id !== id) throw new Error('Task project was not saved');
        await router.push(`/${loc}/tasks/${slug}?project=${id}`);
        return;
      }

      await stageImport(dropped, recipe);
    } catch (error) {
      console.error('Failed to import recipe files:', error);
      toast.error(t('globalDrop.failed'));
    } finally {
      importBusyRef.current = false;
      setImporting(false);
    }
  };

  // 「＋ 自定义流程」卡：拖放文件进空白向导（媒体+字幕混合可配对）
  const handleCustomDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resetDrag();
    void importFiles(collectDropPaths(e));
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
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await window?.ipc?.invoke(
        'deleteWorkItem',
        deleteTarget.id,
      );
      if (result !== true && result !== false)
        throw new Error('Deletion was not acknowledged');
      setWorkItems((prev) =>
        prev.filter((entry) => entry.id !== deleteTarget.id),
      );
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(String(error));
    } finally {
      setDeleting(false);
    }
  };

  const localeStr = String(locale || 'zh');
  const activeRecipe = [...BUILTIN_RECIPES, ...userRecipes].find(
    (recipe) => recipe.id === dragCard,
  );
  const activeRecipeName =
    dragCard === 'custom'
      ? t('recipes.custom')
      : activeRecipe
        ? activeRecipe.builtin
          ? t(`card.${builtinCardKey(activeRecipe.id)}`)
          : activeRecipe.name
        : undefined;
  // 列表只在面板内滚动，不撑高页面；30 条为渲染上限，防止超长列表拖慢首页
  const previewWorkItems = workItems.slice(0, 30);

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
    <div
      className="relative h-full min-h-0"
      onDragEnter={handleGlobalDragEnter}
      onDragLeave={handleGlobalDragLeave}
      onDragOver={handleGlobalDragOver}
      onDrop={handleGlobalDrop}
      onDragEnd={resetDrag}
    >
      <GlobalDropOverlay
        isDragging={globalDragging}
        recipeName={activeRecipeName}
      />
      <ModelQuickDownloadDialog
        open={quickDownloadOpen}
        onOpenChange={setQuickDownloadOpen}
        stagedFilesCount={stagedDraft?.files.length || 0}
        onSuccess={async () => {
          setHasModels(true);
          if (!stagedDraft) return;
          await continueDraft(
            {
              ...stagedDraft,
              config: {
                ...stagedDraft.config,
                transcriptionEngine: 'builtin',
                model: 'base',
                asrProviderId: '',
              },
            },
            true,
          );
        }}
      />
      <AlertDialog
        open={Boolean(pendingImport)}
        onOpenChange={(open) => {
          if (!open) setPendingImport(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('globalDrop.existingTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                taskDraftManager.hasUnreadableDraft
                  ? 'globalDrop.unreadableDescription'
                  : 'globalDrop.existingDescription',
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('recipes.cancel')}</AlertDialogCancel>
            <Button
              variant="outline"
              disabled={importing}
              onClick={() => void resolvePendingImport(false)}
            >
              {t('globalDrop.replaceDraft')}
            </Button>
            <Button
              disabled={importing || taskDraftManager.hasUnreadableDraft}
              onClick={() => void resolvePendingImport(true)}
            >
              {t('globalDrop.appendDraft')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* 窄屏：min-h-full，内容长时页面自然滚动；xl 双栏：h-full 锁定视口高度，
          最近任务在面板内滚动，右栏不再被超长列表撑高 */}
      <div className="h-full overflow-auto">
        <div className="flex min-h-full flex-col gap-2.5 p-3 xl:h-full">
          {draftError && (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-3 bg-warning/10 p-3 text-sm"
            >
              <span className="min-w-0 flex-1">
                {t('globalDrop.storageFailed')}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (stagedDraft)
                    void continueDraft(stagedDraft).catch(() =>
                      toast.error(t('globalDrop.failed')),
                    );
                }}
              >
                {t('globalDrop.retrySave')}
              </Button>
            </div>
          )}
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
                <button
                  type="button"
                  onClick={() => void importFiles()}
                  disabled={importing}
                  aria-label={t('globalDrop.selectFiles')}
                  aria-describedby="launchpad-import-description"
                  aria-busy={importing}
                  className={cn(
                    'group m-2.5 mb-0 flex min-h-16 min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-primary/35 bg-primary/[0.03] px-3 py-2 text-left transition-colors hover:border-primary hover:bg-primary/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-70',
                    globalDragging &&
                      !dragCard &&
                      'border-primary bg-primary/10',
                  )}
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md bg-primary/10 text-primary">
                    {importing ? (
                      <Loader2
                        className="h-5 w-5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Upload className="h-5 w-5" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 basis-40 break-words">
                    <span className="block text-[13px] font-semibold leading-5 text-foreground">
                      {t('globalDrop.entryTitle')}
                      {importing && (
                        <span className="sr-only" role="status">
                          {t('globalDrop.importing')}
                        </span>
                      )}
                    </span>
                    <span
                      id="launchpad-import-description"
                      className="mt-0.5 block text-xs leading-4 text-muted-foreground"
                    >
                      {t('globalDrop.entryDesc')}
                    </span>
                  </span>
                  <span className="ml-auto inline-flex h-8 flex-none items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-foreground group-hover:border-primary/40">
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('globalDrop.selectFiles')}
                  </span>
                </button>
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
                        data-drop-recipe={recipe.id}
                        href={href}
                        className={cn(
                          'group relative overflow-hidden rounded-md border bg-panel-2 p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_6px_16px_-6px_rgba(22,104,220,0.25)] dark:hover:shadow-[0_6px_20px_-6px_rgba(0,0,0,0.55)]',
                          visual.featured &&
                            !block &&
                            'border-primary/25 bg-gradient-to-br from-primary/[0.08] via-primary/[0.04] to-transparent',
                          block &&
                            'border-warning/40 bg-warning/[0.04] hover:border-warning/60',
                          dragCard === recipe.id &&
                            'border-primary bg-primary/10 ring-2 ring-inset ring-primary',
                        )}
                        onDrop={(e) => handleRecipeDrop(e, recipe)}
                      >
                        <CardDecor
                          className={cn(
                            'pointer-events-none absolute right-0 top-0 h-20 w-20 transition-transform duration-300 group-hover:scale-110',
                            visual.decor,
                          )}
                        />
                        {block === 'model' && dragCard !== recipe.id && (
                          <Badge
                            variant="outline"
                            className="absolute right-2.5 top-2.5 border-warning/40 bg-card text-warning group-hover:opacity-0"
                          >
                            {t('needsModelBadge')}
                          </Badge>
                        )}
                        {recipe.id === 'builtin-pipeline' &&
                          !block &&
                          dragCard !== recipe.id && (
                            <Badge
                              variant="outline"
                              className="absolute right-2.5 top-2.5 border-primary/30 bg-primary/5 text-primary text-[10px]"
                            >
                              {t('qualityGateBadge')}
                            </Badge>
                          )}
                        {/* 用户配方管理：hover 重命名/删除（内置无） */}
                        {!recipe.builtin &&
                          !editing &&
                          dragCard !== recipe.id && (
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
                        <div className="mb-2.5 flex h-9 items-center gap-2">
                          <span
                            className={cn(
                              'inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg',
                              visual.chip,
                            )}
                          >
                            <Icon className="h-5 w-5" />
                          </span>
                          {dragCard === recipe.id && (
                            <span className="min-w-0 text-xs font-medium text-primary">
                              {t('dropHint')}
                            </span>
                          )}
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
                            {label}
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
                    data-drop-recipe="custom"
                    href={`/${localeStr}/tasks/new`}
                    className={cn(
                      'group relative flex min-h-[110px] flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-panel-2/50 p-3 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.03]',
                      dragCard === 'custom' &&
                        'border-primary bg-primary/10 ring-2 ring-inset ring-primary',
                    )}
                    onDrop={handleCustomDrop}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
                      <Plus className="h-5 w-5" />
                    </span>
                    <div className="text-[13px] font-medium">
                      {t('recipes.custom')}
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {t('recipes.customDesc')}
                    </p>
                  </Link>
                </div>
                {/* 窄屏工具行：右栏（工具箱面板）堆叠后沉底，这里保留紧凑入口兜底可见性 */}
                <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2 xl:hidden">
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

            {/* 右栏固定三模块（环境+工具箱+上手），极矮窗口装不下时列内滚动兜底 */}
            <div className="flex min-h-0 min-w-0 flex-col gap-2.5 xl:overflow-y-auto">
              {/* flex-none：视口锁高后右栏空间有限时，常显仪表不被压缩，剩余高度全部交给快速上手 */}
              <EnvReadiness
                className="flex-none"
                title={t('env.title')}
                readyBadge={hasModels ? t('env.canWork') : null}
                rows={envRows}
              />
              {/* 工具箱：三个独立工具的常显入口，紧跟环境就绪（xl 专属；窄屏由左栏工具行兜底）。
                行式布局带图标 chip + 名称 + 一句话说明，可见度与配方卡对齐但不抢「开始创作」主动线 */}
              <Panel className="hidden flex-none xl:flex">
                <PanelHeader title={t('tools.panelTitle')} />
                <div className="flex flex-col py-1">
                  {TOOLS.map((tool) => {
                    const ToolIcon = tool.icon;
                    return (
                      <Link
                        key={tool.key}
                        href={`/${localeStr}/${tool.href}`}
                        className="group flex items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent/60"
                      >
                        <span
                          className={cn(
                            'flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-105',
                            tool.chip,
                          )}
                        >
                          <ToolIcon className="h-[18px] w-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-medium leading-tight">
                            {t(`card.${tool.key}`)}
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground">
                            {t(`tools.${tool.key}Hint`)}
                          </span>
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 flex-none text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                      </Link>
                    );
                  })}
                </div>
              </Panel>
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
                        <span className="min-w-0 flex-1 break-words text-muted-foreground">
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
      </div>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('recent.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('recent.deleteDesc', { name: deleteTarget?.name || '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div role="alert" className="break-words text-sm text-destructive">
              <p>{t('recent.deleteFailed')}</p>
              <details>
                <summary>{t('recent.errorDetails')}</summary>
                {deleteError}
              </details>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('recent.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="gap-1.5"
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
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

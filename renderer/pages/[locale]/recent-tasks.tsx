import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  History,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import WorkItemList from '@/components/launchpad/WorkItemList';
import WorkItemRowsSkeleton from '@/components/launchpad/WorkItemRowsSkeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import {
  filterWorkItems,
  getWorkItemTarget,
  WORK_ITEM_TYPE_FILTERS,
} from 'lib/workItemUtils';
import type { WorkItem, WorkItemType } from '../../../types/workItem';

const PAGE_SIZE = 20;

export default function RecentTasksPage() {
  const router = useRouter();
  const { locale } = router.query;
  const localeStr = String(locale || 'zh');
  const { t } = useTranslation('launchpad');
  const { t: tTasks } = useTranslation('tasks');

  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | WorkItemType>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<WorkItem | null>(null);
  const [clearAllOpen, setClearAllOpen] = useState(false);
  const [page, setPage] = useState(1);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const items = await window?.ipc?.invoke('getWorkItems');
      setWorkItems(items || []);
    } catch (error) {
      console.error('Failed to load work items:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const filteredItems = useMemo(
    () => filterWorkItems(workItems, query, typeFilter),
    [workItems, query, typeFilter],
  );

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));

  const paginatedItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredItems.slice(start, start + PAGE_SIZE);
  }, [filteredItems, page]);

  useEffect(() => {
    setPage(1);
  }, [query, typeFilter]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const pageFrom = filteredItems.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const pageTo = Math.min(page * PAGE_SIZE, filteredItems.length);

  const getTypeFilterLabel = (value: 'all' | WorkItemType) => {
    if (value === 'all') return t('allTasks.typeAll');
    if (value === 'proofread') return t('card.proofread');
    if (value === 'dubbing') return t('card.dubbing');
    const slug =
      value === 'generateAndTranslate'
        ? 'generate-translate'
        : value === 'generateOnly'
          ? 'generate'
          : 'translate';
    return tTasks(`pageTitle.${slug}`);
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

  const confirmClearAll = async () => {
    await window?.ipc?.invoke('clearAllWorkItems');
    setWorkItems([]);
    setClearAllOpen(false);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl space-y-3 p-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-8 text-muted-foreground"
          asChild
        >
          <Link href={`/${localeStr}/home`}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            {t('allTasks.back')}
          </Link>
        </Button>

        <PageHeader
          title={t('allTasks.title')}
          description={t('allTasks.description')}
          actions={
            workItems.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setClearAllOpen(true)}
              >
                <Trash2 className="mr-1.5 h-4 w-4" />
                {t('allTasks.clearAll')}
              </Button>
            ) : null
          }
        />

        {workItems.length > 0 && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('allTasks.searchPlaceholder')}
                className="h-9 pl-9 text-sm"
              />
            </div>
            <Select
              value={typeFilter}
              onValueChange={(value) =>
                setTypeFilter(value as 'all' | WorkItemType)
              }
            >
              <SelectTrigger className="h-9 w-full sm:w-[220px]">
                <SelectValue placeholder={t('allTasks.typeFilter')} />
              </SelectTrigger>
              <SelectContent>
                {WORK_ITEM_TYPE_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {getTypeFilterLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {!loading && workItems.length > 0 && filteredItems.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('allTasks.pageRange', {
              from: pageFrom,
              to: pageTo,
              total: filteredItems.length,
            })}
          </p>
        )}

        {loading ? (
          <WorkItemRowsSkeleton rows={8} />
        ) : workItems.length === 0 ? (
          <EmptyState
            icon={History}
            title={t('allTasks.emptyTitle')}
            description={t('allTasks.emptyHint')}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={`/${localeStr}/home`}>
                  <ArrowLeft className="mr-1.5 h-4 w-4" />
                  {t('allTasks.emptyCta')}
                </Link>
              </Button>
            }
          />
        ) : filteredItems.length === 0 ? (
          <p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
            {t('allTasks.noMatch')}
          </p>
        ) : (
          <div className="space-y-4">
            <WorkItemList
              items={paginatedItems}
              locale={localeStr}
              editingId={editingId}
              nameDraft={nameDraft}
              onNameDraftChange={setNameDraft}
              onStartRename={startRename}
              onCommitRename={commitRename}
              onCancelRename={() => setEditingId(null)}
              onDelete={setDeleteTarget}
              onOpen={(item) => router.push(getWorkItemTarget(item, localeStr))}
              tLaunchpad={t}
              tTasks={tTasks}
            />
            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-3 pt-1">
                <p className="text-xs text-muted-foreground tabular-nums">
                  {t('allTasks.pageInfo', { page, totalPages })}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    {t('allTasks.prevPage')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    {t('allTasks.nextPage')}
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
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
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {t('recent.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction className="gap-1.5" onClick={confirmDelete}>
              <Trash2 className="h-4 w-4" />
              {t('recent.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearAllOpen} onOpenChange={setClearAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('allTasks.clearAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('allTasks.clearAllDesc', { count: workItems.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {t('recent.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmClearAll}
            >
              <Trash2 className="h-4 w-4" />
              {t('allTasks.clearAllConfirm')}
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

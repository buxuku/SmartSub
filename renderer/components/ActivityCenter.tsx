import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from 'lib/utils';
import {
  formatWorkItemTime,
  getWorkItemStatus,
  getWorkItemTarget,
  STATUS_DOT,
} from 'lib/workItemUtils';
import type { WorkItem } from '../../types/workItem';

export interface ActivityDownload {
  model: string;
  progress: number;
  status: string;
}

/**
 * 任务中枢 / 活动面板：把散落的实时状态（运行中的任务、模型下载、最近完成 / 失败）
 * 汇聚到顶栏 popover 一处可见可控。版本与更新提示落在页脚，更新可用时按钮显示提示点。
 * 仅只读消费既有信号（taskRunning / download / getWorkItems / taskComplete），不改任何后端行为。
 */
export default function ActivityCenter({
  locale,
  taskRunning,
  download,
  updateAvailable,
  version,
  newVersion,
  onShowUpdate,
}: {
  locale: string;
  taskRunning: boolean;
  download: ActivityDownload | null;
  updateAvailable: boolean;
  version: string;
  newVersion: string;
  onShowUpdate: () => void;
}) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<WorkItem[]>([]);
  const [recentLoaded, setRecentLoaded] = useState(false);

  const loadRecent = useCallback(async () => {
    try {
      const items: WorkItem[] = await window?.ipc?.invoke('getWorkItems');
      const sorted = (items || [])
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 5);
      setRecent(sorted);
    } catch {
      setRecent([]);
    } finally {
      setRecentLoaded(true);
    }
  }, []);

  // 打开时拉取最近工程
  useEffect(() => {
    if (open) loadRecent();
  }, [open, loadRecent]);

  // 任务完成即时刷新「最近」
  useEffect(() => {
    const cleanup = window?.ipc?.on('taskComplete', () => {
      loadRecent();
    });
    return () => cleanup?.();
  }, [loadRecent]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const downloadActive =
    download && download.status !== 'completed' && download.status !== 'error';
  const busy = taskRunning || Boolean(downloadActive);
  const recentLoading = !recentLoaded && recent.length === 0;
  const isEmpty =
    recentLoaded && !taskRunning && !download && recent.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-7 w-7 text-muted-foreground hover:text-foreground"
          aria-label={t('activity.aria')}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Activity className="h-4 w-4" />
          )}
          {updateAvailable && (
            <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-0">
        <div className="max-h-[420px] overflow-y-auto py-1">
          {taskRunning && (
            <ActivitySection title={t('activity.runningTitle')}>
              <button
                type="button"
                onClick={() => go(`/${locale}/recent-tasks`)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
              >
                <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary" />
                <span className="min-w-0 flex-1 truncate">
                  {t('taskRunningPill.label')}
                </span>
                <span className="flex-shrink-0 text-[11px] text-primary">
                  {t('activity.view')}
                </span>
              </button>
            </ActivitySection>
          )}

          {download && (
            <ActivitySection title={t('activity.downloadsTitle')}>
              <div className="space-y-1.5 px-3 py-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {download.status === 'completed' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                    ) : download.status === 'error' ? (
                      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-destructive" />
                    ) : (
                      <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" />
                    )}
                    <span className="truncate">{download.model}</span>
                  </span>
                  <span className="flex-shrink-0 font-mono text-[11px] text-muted-foreground">
                    {download.status === 'completed'
                      ? '100%'
                      : download.status === 'error'
                        ? '—'
                        : download.status === 'extracting'
                          ? t('downloadPill.extracting', { model: '' }).trim()
                          : `${Math.round(download.progress)}%`}
                  </span>
                </div>
                {download.status !== 'error' && (
                  <Progress
                    value={
                      download.status === 'completed' ? 100 : download.progress
                    }
                    className="h-1"
                  />
                )}
              </div>
            </ActivitySection>
          )}

          {recentLoading && !taskRunning && !download && (
            <ActivitySection title={t('activity.recentTitle')}>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-3 py-1.5"
                  aria-hidden="true"
                >
                  <Skeleton className="h-1.5 w-1.5 flex-shrink-0 rounded-full" />
                  <Skeleton className="h-3.5 min-w-0 flex-1" />
                  <Skeleton className="h-3 w-10 flex-shrink-0" />
                </div>
              ))}
            </ActivitySection>
          )}

          {recent.length > 0 && (
            <ActivitySection title={t('activity.recentTitle')}>
              {recent.map((item) => {
                const status = getWorkItemStatus(item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => go(getWorkItemTarget(item, locale))}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/60"
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 flex-shrink-0 rounded-full',
                        STATUS_DOT[status],
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground">
                      {formatWorkItemTime(item.updatedAt)}
                    </span>
                  </button>
                );
              })}
            </ActivitySection>
          )}

          {isEmpty && (
            <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
              <Activity className="h-5 w-5 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">
                {t('activity.empty')}
              </p>
            </div>
          )}
        </div>

        <Separator />
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <button
            type="button"
            onClick={() => go(`/${locale}/recent-tasks`)}
            className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('activity.viewAll')}
            <ChevronRight className="h-3 w-3" />
          </button>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">v{version}</span>
            {updateAvailable && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onShowUpdate();
                }}
                className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
              >
                {t('newVersionBadge', { version: newVersion })}
              </button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ActivitySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1">
      <div className="px-3 pb-1">
        <span className="label-caps">{title}</span>
      </div>
      {children}
    </div>
  );
}

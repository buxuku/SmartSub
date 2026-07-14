import React from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from 'lib/utils';
import type { WorkItem } from '../../../types/workItem';
import {
  STATUS_DOT,
  formatWorkItemTime,
  getWorkItemFileCount,
  getWorkItemStatus,
  getWorkItemTypeLabel,
  type RecentStatus,
} from 'lib/workItemUtils';

export interface WorkItemListProps {
  items: WorkItem[];
  locale: string;
  editingId: string | null;
  nameDraft: string;
  onNameDraftChange: (value: string) => void;
  onStartRename: (item: WorkItem) => void;
  onCommitRename: (item: WorkItem) => void;
  onCancelRename: () => void;
  onDelete: (item: WorkItem) => void;
  onOpen: (item: WorkItem) => void;
  tLaunchpad: (key: string, options?: Record<string, unknown>) => string;
  tTasks: (key: string) => string;
  showUpdatedAt?: boolean;
  /** 嵌入 Panel 内时去掉外框（由容器提供边界） */
  flush?: boolean;
}

export default function WorkItemList({
  items,
  editingId,
  nameDraft,
  onNameDraftChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
  onOpen,
  tLaunchpad,
  tTasks,
  showUpdatedAt = true,
  flush = false,
}: WorkItemListProps) {
  return (
    <div className={cn('divide-y', !flush && 'rounded-lg border')}>
      {items.map((item) => {
        const status = getWorkItemStatus(item);
        const editing = editingId === item.id;
        return (
          <div
            key={item.id}
            className="group flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors cursor-pointer"
            onClick={() => {
              if (!editing) onOpen(item);
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
                onChange={(e) => onNameDraftChange(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCommitRename(item);
                  if (e.key === 'Escape') onCancelRename();
                }}
                onBlur={() => onCommitRename(item)}
                className="h-7 text-xs min-w-0 flex-1"
              />
            ) : (
              <span className="truncate text-sm min-w-0 flex-1">
                {item.name}
              </span>
            )}
            <span className="hidden sm:inline text-[11px] text-muted-foreground rounded bg-muted px-1.5 py-0.5 flex-shrink-0">
              {getWorkItemTypeLabel(item, tLaunchpad, tTasks)}
            </span>
            <span className="text-xs text-muted-foreground flex-shrink-0">
              {tLaunchpad('fileCount', {
                count: getWorkItemFileCount(item),
              })}
            </span>
            {showUpdatedAt ? (
              <span className="hidden md:inline text-xs text-muted-foreground/70 tabular-nums flex-shrink-0">
                {formatWorkItemTime(item.updatedAt)}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground flex-shrink-0 w-12 text-right">
              {tLaunchpad(`status.${status as RecentStatus}`)}
            </span>
            <span
              className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={tLaunchpad('recent.rename')}
                onClick={() => onStartRename(item)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                aria-label={tLaunchpad('recent.delete')}
                onClick={() => onDelete(item)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

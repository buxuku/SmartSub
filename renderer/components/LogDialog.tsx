import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { Button } from './ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { ScrollArea } from './ui/scroll-area';
import { useTranslation } from 'next-i18next';
import { Copy, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

type LogEntry = {
  timestamp: number;
  message: string;
  type?: 'info' | 'error' | 'warning';
};

type TypeFilter = 'all' | 'error' | 'warning';

const LIMIT_OPTIONS = [50, 100, 200];

/** 本地时区的 YYYY-MM-DD，与主进程日志文件命名一致 */
function todayLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function LogDialog({ open, onOpenChange }) {
  const { t } = useTranslation('common');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(todayLocalDate());
  const [limit, setLimit] = useState<number>(100);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  const today = todayLocalDate();
  const isViewingToday = selectedDate === today;

  const scrollToBottom = useCallback(() => {
    // 真正可滚动的是 Radix 的 viewport，而非 ScrollArea 根节点
    requestAnimationFrame(() => {
      const viewport = scrollRef.current?.querySelector(
        '[data-radix-scroll-area-viewport]',
      ) as HTMLElement | null;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });
  }, []);

  // 打开弹窗时加载可用日期，并按当前条件查询
  useEffect(() => {
    if (!open) return;
    window.ipc.invoke('getLogDates').then((list: string[]) => {
      const merged = list?.includes(today) ? list : [today, ...(list || [])];
      setDates(merged);
    });
  }, [open, today]);

  useEffect(() => {
    if (!open) return;
    window.ipc
      .invoke('getLogs', {
        date: selectedDate,
        limit,
        ...(typeFilter !== 'all' ? { types: [typeFilter] } : {}),
      })
      .then((result: LogEntry[]) => {
        setLogs(result || []);
        scrollToBottom();
      });
  }, [open, selectedDate, limit, typeFilter, scrollToBottom]);

  // 实时追加：仅在查看今天且匹配类型过滤时生效
  useEffect(() => {
    if (!open || !isViewingToday) return;
    const handleNewLog = (log: LogEntry) => {
      if (typeFilter !== 'all' && (log.type || 'info') !== typeFilter) return;
      setLogs((prev) => [...prev, log]);
      scrollToBottom();
    };
    const unsubscribe = window.ipc.on('newLog', handleNewLog);
    return () => {
      unsubscribe();
    };
  }, [open, isViewingToday, typeFilter, scrollToBottom]);

  const handleClearLogs = async () => {
    await window.ipc.invoke('clearLogs');
    setLogs([]);
    setDates([today]);
    setSelectedDate(today);
  };

  const handleCopyLogs = async () => {
    if (logs.length === 0) {
      toast.info(t('noLogsToCopy'));
      return;
    }

    const logsText = logs
      .map((log) => {
        const timestamp = new Date(log.timestamp).toLocaleString();
        const type = log.type ? `[${log.type.toUpperCase()}]` : '[INFO]';
        return `${timestamp} ${type} ${log.message}`;
      })
      .join('\n');

    try {
      await navigator.clipboard.writeText(logsText);
      toast.success(t('copySuccess'));
    } catch (error) {
      console.error('Failed to copy logs:', error);
      toast.error(t('copyFailed'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] grid-rows-[auto_auto_1fr_auto]">
        <DialogHeader>
          <DialogTitle>{t('logs')}</DialogTitle>
          <DialogDescription>{t('logsDesc')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={selectedDate} onValueChange={setSelectedDate}>
            <SelectTrigger className="w-36 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dates.map((date) => (
                <SelectItem key={date} value={date}>
                  {date === today ? t('logDateToday') : date}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(limit)}
            onValueChange={(v) => setLimit(Number(v))}
          >
            <SelectTrigger className="w-32 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIMIT_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t('logLatestN', { count: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={typeFilter}
            onValueChange={(v) => setTypeFilter(v as TypeFilter)}
          >
            <SelectTrigger className="w-28 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('logTypeAll')}</SelectItem>
              <SelectItem value="error">{t('logTypeError')}</SelectItem>
              <SelectItem value="warning">{t('logTypeWarning')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ScrollArea
          ref={scrollRef}
          className="min-h-0 rounded-md border bg-muted/50 shadow-sunken dark:bg-background/50"
        >
          <div className="space-y-2 p-4">
            {logs.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('logsEmpty')}</p>
            )}
            {logs.map((log, index) => (
              <div key={`${log.timestamp}-${index}`}>
                <div
                  className={`text-sm whitespace-pre-wrap break-all font-mono ${
                    log?.type === 'error'
                      ? 'text-destructive'
                      : log?.type === 'warning'
                        ? 'text-warning'
                        : 'text-muted-foreground'
                  }`}
                >
                  <span className="text-muted-foreground">
                    {new Date(log?.timestamp).toLocaleString()}
                  </span>
                  {' - '}
                  {log?.message}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="flex justify-end space-x-2 mt-4 shrink-0">
          <Button variant="outline" onClick={handleCopyLogs}>
            <Copy className="h-4 w-4 mr-2" />
            {t('copyLogs')}
          </Button>
          <Button
            variant="outline"
            className="text-muted-foreground hover:text-destructive"
            onClick={handleClearLogs}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            {t('clearLogs')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

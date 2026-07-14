import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Terminal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from 'lib/utils';
import { useTranslation } from 'next-i18next';

type LogEntry = {
  timestamp: number;
  message: string;
  type?: 'info' | 'error' | 'warning';
};

const LogPanel: React.FC<{
  className?: string;
  /** 提供时只显示该工程的日志（系统/Updater 日志不再混入） */
  projectId?: string | null;
}> = ({ className, projectId }) => {
  const { t } = useTranslation('tasks');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectId) {
      setLogs([]);
      return;
    }
    setLogs([]);
    window?.ipc?.invoke('getLogs', projectId).then((initial: LogEntry[]) => {
      setLogs(initial || []);
    });
    const unsubscribe = window?.ipc?.on(
      'newLog',
      (log: LogEntry & { projectId?: string }) => {
        if (log?.projectId !== projectId) return;
        setLogs((prev) => [...prev, log]);
      },
    );
    return () => {
      unsubscribe?.();
    };
  }, [projectId]);

  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, expanded]);

  const handleClear = async () => {
    if (!projectId) return;
    await window?.ipc?.invoke('clearLogs', projectId);
    setLogs([]);
  };

  const lastLog = logs[logs.length - 1];
  // 折叠态预览压成单行，避免换行/超长内容把页面撑出横向滚动条
  const lastLogPreview = lastLog
    ? lastLog.message.replace(/\s+/g, ' ').trim()
    : '';

  return (
    <div className={cn('min-w-0 max-w-full', className)}>
      <div className="rounded-lg border bg-muted/30 overflow-hidden">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 overflow-hidden px-3 py-1.5 text-left"
          onClick={() => setExpanded(!expanded)}
        >
          <Terminal className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <span className="text-xs font-medium text-muted-foreground flex-shrink-0">
            {t('logs.title')}
          </span>
          {!expanded && (
            <span className="text-[11px] text-faint truncate font-mono min-w-0 flex-1">
              {lastLog ? lastLogPreview : t('logs.empty')}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 flex-shrink-0">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </span>
        </button>
        {expanded && (
          <div className="border-t">
            <div
              ref={scrollRef}
              className="max-h-44 overflow-y-auto overflow-x-hidden px-3 py-2 space-y-0.5"
            >
              {logs.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {t('logs.empty')}
                </p>
              )}
              {logs.map((log, index) => (
                <div
                  key={index}
                  className={`text-[11px] font-mono whitespace-pre-wrap break-all ${
                    log?.type === 'error'
                      ? 'text-destructive'
                      : log?.type === 'warning'
                        ? 'text-warning'
                        : 'text-muted-foreground'
                  }`}
                >
                  <span className="text-faint">
                    {new Date(log?.timestamp).toLocaleTimeString()}
                  </span>{' '}
                  {log?.message}
                </div>
              ))}
            </div>
            <div className="flex justify-end border-t px-2 py-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px] gap-1 text-muted-foreground"
                onClick={handleClear}
                disabled={!projectId}
              >
                <Trash2 className="h-3 w-3" />
                {t('logs.clear')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default LogPanel;

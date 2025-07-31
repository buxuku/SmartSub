import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { useTranslation } from 'next-i18next';

type LogEntry = {
  timestamp: number;
  message: string;
  type?: 'info' | 'error' | 'warning';
};

export function LogDialog({ open, onOpenChange }) {
  const { t } = useTranslation('common');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 初始加载日志
    window.ipc.invoke('getLogs').then(setLogs);

    // 监听新日志
    const handleNewLog = (log: LogEntry) => {
      setLogs((prev) => [...prev, log]);
      // 使用 requestAnimationFrame 确保在下一帧更新滚动位置
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    };

    const unsubscribe = window.ipc.on('newLog', handleNewLog);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleClearLogs = async () => {
    await window.ipc.invoke('clearLogs');
    setLogs([]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{t('logs')}</DialogTitle>
          <DialogDescription>
            View application logs and system messages for debugging and
            monitoring.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea ref={scrollRef} className="h-[60vh]">
          <div className="space-y-2 p-4 w-[700px] overflow-x-scroll">
            {logs.map((log, index) => (
              <div key={index}>
                <div
                  className={`text-sm whitespace-pre font-mono inline-block min-w-fit ${
                    log?.type === 'error'
                      ? 'text-red-500'
                      : log?.type === 'warning'
                        ? 'text-yellow-500'
                        : 'text-gray-700'
                  }`}
                >
                  <span className="text-gray-500">
                    {new Date(log?.timestamp).toLocaleString()}
                  </span>
                  {' - '}
                  {log?.message}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="flex justify-end space-x-2 mt-4">
          <Button variant="destructive" onClick={handleClearLogs}>
            {t('clearLogs')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

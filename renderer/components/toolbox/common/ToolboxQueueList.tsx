import { CheckCircle2, Loader2, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import type { ToolboxQueueItem } from '../../../lib/toolboxQueue';

interface Props<I, R> {
  items: ToolboxQueueItem<I, R>[];
  running: boolean;
  cancelling: boolean;
  error?: string;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onCancel: () => void;
  onClear: () => void;
  onSelect?: (id: string) => void;
  selectedId?: string;
  renderActions?: (item: ToolboxQueueItem<I, R>) => React.ReactNode;
  renderInfo?: (item: ToolboxQueueItem<I, R>) => React.ReactNode;
}

export default function ToolboxQueueList<I, R>(props: Props<I, R>) {
  const { t } = useTranslation('toolbox');
  if (!props.items.length) return null;
  return (
    <section
      aria-label={t('queue.title')}
      className="flex min-h-0 min-w-0 shrink-0 flex-col"
      data-testid="toolbox-queue"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 py-2 text-xs">
        <span>
          {t('queue.title')} ({props.items.length})
        </span>
        {props.running ? (
          <Button
            size="sm"
            variant="outline"
            disabled={props.cancelling}
            onClick={props.onCancel}
            className="h-7 gap-1 text-xs"
          >
            <Square className="h-3 w-3" />
            {t(props.cancelling ? 'queue.stopping' : 'queue.stop')}
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            title={t('queue.clear')}
            aria-label={t('queue.clear')}
            onClick={props.onClear}
            className="h-7 w-7"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {props.error && (
        <p role="alert" className="break-words py-2 text-xs text-destructive">
          {props.error}
        </p>
      )}
      <div className="max-h-56 min-h-0 overflow-y-auto divide-y divide-border/50">
        {props.items.map((item) => (
          <div
            key={item.id}
            data-status={item.status}
            className={`flex min-w-0 items-start gap-2 px-2 py-2 text-xs ${props.selectedId === item.id ? 'bg-primary/10' : 'bg-muted/20'}`}
          >
            <div className="min-w-0 flex-1">
              {props.onSelect ? (
                <button
                  className="block w-full truncate text-left font-medium"
                  title={item.filePath}
                  disabled={props.running}
                  onClick={() => props.onSelect?.(item.id)}
                >
                  {item.fileName}
                </button>
              ) : (
                <p className="truncate font-medium" title={item.filePath}>
                  {item.fileName}
                </p>
              )}
              {props.renderInfo?.(item)}
              <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                {item.status === 'running' && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {item.status === 'done' && (
                  <CheckCircle2 className="h-3 w-3 text-green-600" />
                )}
                <span>{t(`queue.${item.status}`)}</span>
                {item.progress !== undefined && (
                  <span className="font-mono">
                    {Math.round(item.progress)}%
                  </span>
                )}
              </div>
              {item.progress !== undefined && (
                <Progress value={item.progress} className="mt-1 h-1" />
              )}
              {item.status === 'error' && (
                <details className="mt-1 text-destructive" open>
                  <summary>{t('queue.errorDetails')}</summary>
                  <p
                    role="alert"
                    className="break-words whitespace-pre-wrap pt-1"
                  >
                    {item.error}
                  </p>
                </details>
              )}
            </div>
            {(item.status === 'error' || item.status === 'cancelled') && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                disabled={props.running}
                title={t('queue.retry')}
                aria-label={t('queue.retry')}
                onClick={() => props.onRetry(item.id)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
            {props.renderActions?.(item)}
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0"
              disabled={props.running}
              title={t('queue.remove')}
              aria-label={t('queue.remove')}
              onClick={() => props.onRemove(item.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { useRouter } from 'next/router';
import {
  ArrowUp,
  Sparkles,
  Loader2,
  Plus,
  Square,
  Trash2,
  X,
  ChevronRight,
  FolderOpen,
  Menu,
  MessageSquare,
  Paperclip,
  FileText,
  FileAudio,
  FileVideo,
  Upload,
  PanelLeftClose,
  Camera,
} from 'lucide-react';
import { useAssistant } from '../../context/AssistantContext';
import { Button } from '../ui/button';
import { getWorkItemTarget } from '../../lib/workItemUtils';
import type {
  AssistantMessage,
  AssistantProvider,
  AssistantRunEvent,
  AssistantSession,
  AssistantToolCall,
  AssistantAttachment,
} from '../../../types/assistant';
import { ASSISTANT_MAX_ATTACHMENTS } from '../../../types/assistant';
import { ASSISTANT_ATTACHMENT_ACCEPT } from '../../../types/assistantAttachments';
import type { AutomationJob } from '../../../types/automation';
import AssistantMarkdown from './AssistantMarkdown';
import { useAssistantPanelLayout } from './useAssistantPanelLayout';
import { isMacPlatform } from '../../hooks/useHotkeys';

function AttachmentIcon({ kind }: { kind: AssistantAttachment['kind'] }) {
  const Icon =
    kind === 'video' ? FileVideo : kind === 'audio' ? FileAudio : FileText;
  return <Icon className="h-4 w-4 shrink-0 text-primary" />;
}

const settledJob = (job: AutomationJob) =>
  ['completed', 'failed', 'cancelled', 'interrupted', 'review'].includes(
    job.status,
  );

function newerJob(previous: AutomationJob | undefined, next: AutomationJob) {
  if (!previous || previous.id !== next.id) return next;
  if (previous.updatedAt > next.updatedAt) return previous;
  if (
    previous.updatedAt === next.updatedAt &&
    settledJob(previous) &&
    !settledJob(next)
  )
    return previous;
  return next;
}

function progressLabel(value: any): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value))
    return `${Math.round(value)}%`;
  if (!value || typeof value !== 'object') return undefined;
  if (
    typeof value.completed === 'number' &&
    typeof value.total === 'number' &&
    value.total > 0
  )
    return `${value.completed} / ${value.total}`;
  if (typeof value.processedSeconds === 'number' && value.durationSeconds > 0)
    return `${Math.min(100, Math.round((value.processedSeconds / value.durationSeconds) * 100))}%`;
  if (Array.isArray(value))
    return value.map(progressLabel).filter(Boolean).join(' · ') || undefined;
  return progressLabel(
    value.activity || value.progress || value.percent || value.data,
  );
}

function ToolCard({
  tool,
  onError,
}: {
  tool: AssistantToolCall;
  onError(error: string): void;
}) {
  const { t } = useTranslation('common');
  const router = useRouter();
  const [job, setJob] = useState<AutomationJob | undefined>(tool.job);
  useEffect(() => {
    if (tool.job) setJob((previous) => newerJob(previous, tool.job!));
  }, [tool.job]);
  const jobId = tool.job?.id;
  const polling = !job || !settledJob(job);
  useEffect(() => {
    if (!jobId || !polling) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.ipc.invoke('assistant:task', { id: jobId });
        if (disposed) return;
        setJob((previous) => newerJob(previous, next));
        if (!settledJob(next)) timer = setTimeout(poll, 2000);
      } catch (error) {
        if (!disposed) onError(String(error));
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [jobId, polling]);
  const status = job?.status || tool.status;
  const viewTask = async () => {
    try {
      const item = await window.ipc.invoke(
        'getWorkItem',
        job?.projectId || job?.id,
      );
      await router.push(
        item
          ? getWorkItemTarget(item, String(router.query.locale || 'zh'))
          : `/${router.query.locale || 'zh'}/recent-tasks`,
      );
    } catch (error) {
      onError(String(error));
    }
  };
  const active = ['queued', 'running', 'paused', 'cancelling'].includes(status);
  return (
    <div
      className="rounded-lg border bg-muted/20 text-xs"
      data-testid="assistant-tool"
    >
      <details>
        <summary className="flex cursor-pointer items-center gap-2 p-3">
          {active ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 break-words font-medium">
            {tool.name.startsWith('assistant_')
              ? t(`assistant.tools.${tool.name.slice(10)}`)
              : tool.name.replace(/^smartsub_/, '').replace(/_/g, ' ')}
          </span>
          <span
            className={
              status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
            }
          >
            {t(`assistant.status.${status}`)}
          </span>
        </summary>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all border-t p-3 text-[11px] text-muted-foreground">
          {JSON.stringify(
            {
              arguments: (() => {
                try {
                  return JSON.parse(tool.arguments);
                } catch {
                  return tool.arguments;
                }
              })(),
              result: job || tool.result,
            },
            null,
            2,
          )}
        </pre>
      </details>
      {Boolean((tool.result as any)?.screenshot?.imagePath) && (
        <div className="border-t p-2.5">
          <div className="overflow-hidden rounded-lg border bg-black/5 dark:bg-white/5">
            <img
              src={`media://${encodeURIComponent((tool.result as any).screenshot.imagePath)}`}
              alt={t('assistant.screenshotPreview')}
              className="max-h-48 w-full cursor-pointer object-contain transition-opacity hover:opacity-90"
              onClick={() =>
                void window.ipc
                  ?.invoke(
                    'toolbox:openFolder',
                    (tool.result as any).screenshot.imagePath,
                  )
                  ?.catch((error: unknown) => onError(String(error)))
              }
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-muted-foreground">
            <span>
              {(tool.result as any).screenshot.width} ×{' '}
              {(tool.result as any).screenshot.height}
            </span>
            <button
              className="text-primary hover:underline"
              onClick={() =>
                void window.ipc
                  ?.invoke(
                    'toolbox:openFolder',
                    (tool.result as any).screenshot.imagePath,
                  )
                  ?.catch((error: unknown) => onError(String(error)))
              }
            >
              {t('assistant.openScreenshot')}
            </button>
          </div>
        </div>
      )}
      {job && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono" title={job.id}>
            {job.id.slice(0, 8)}
          </span>
          {job.progress != null && (
            <span className="max-w-40 truncate text-muted-foreground">
              {progressLabel(job.progress) || t('assistant.progress')}
            </span>
          )}
          <button
            className="text-primary hover:underline"
            onClick={() => void viewTask()}
          >
            {t('assistant.viewTask')}
          </button>
          {job.actions?.includes('cancel') && (
            <button
              className="text-destructive hover:underline"
              onClick={() =>
                void window.ipc
                  .invoke('assistant:cancel-task', { id: job.id })
                  .then((next) =>
                    setJob((previous) => newerJob(previous, next)),
                  )
                  .catch((error) => onError(String(error)))
              }
            >
              {t('assistant.cancelTask')}
            </button>
          )}
          {job.artifacts?.map((artifact) => (
            <button
              key={artifact.path}
              title={artifact.path}
              className="flex max-w-full items-center gap-1 text-primary hover:underline"
              onClick={() =>
                void window.ipc
                  .invoke('toolbox:openFolder', artifact.path)
                  .catch((error) => onError(String(error)))
              }
            >
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {artifact.path.split(/[\\/]/).pop()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({
  message,
  onError,
}: {
  message: AssistantMessage;
  onError(error: string): void;
}) {
  const { t } = useTranslation('common');
  return (
    <article
      className={`space-y-2 ${message.role === 'user' ? 'ml-7 rounded-xl bg-primary/10 p-3' : ''}`}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t(message.role === 'user' ? 'assistant.you' : 'assistant.title')}
      </div>
      {message.context && (
        <div className="truncate text-[10px] text-muted-foreground">
          {message.context.editor
            ? `${t('assistant.line', { index: message.context.editor.selectedIndex + 1 })} · `
            : ''}
          {message.context.files?.[0]?.split(/[\\/]/).pop() ||
            message.context.page}
          {message.context.recentErrors?.length
            ? ` · ${t('assistant.hasErrors')}`
            : ''}
        </div>
      )}
      {message.attachments?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {message.attachments.map((file) => (
            <div
              key={file.id}
              title={file.path}
              className="flex max-w-full items-center gap-2 rounded-lg border bg-background/70 px-2.5 py-2 text-xs"
            >
              <AttachmentIcon kind={file.kind} />
              <span className="truncate">{file.name}</span>
            </div>
          ))}
        </div>
      )}
      {message.content &&
        (message.role === 'assistant' ? (
          <AssistantMarkdown>{message.content}</AssistantMarkdown>
        ) : (
          <p
            className="whitespace-pre-wrap break-words text-sm leading-6"
            data-testid="assistant-message"
          >
            {message.content}
          </p>
        ))}
      {message.tools?.map((tool) => (
        <ToolCard key={tool.id} tool={tool} onError={onError} />
      ))}
    </article>
  );
}

export default function AssistantPanel() {
  const assistant = useAssistant();
  const { t } = useTranslation('common');
  const router = useRouter();
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [session, setSession] = useState<AssistantSession>();
  const selected = useRef('');
  const [providers, setProviders] = useState<AssistantProvider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [attachContext, setAttachContext] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [deleteError, setDeleteError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
  const [importing, setImporting] = useState(false);
  const importFlight = useRef(false);
  const draftEpoch = useRef(0);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const historyToggle = useRef<HTMLButtonElement>(null);
  const close = useCallback(
    () => assistant?.setOpen(false),
    [assistant?.setOpen],
  );
  const layout = useAssistantPanelLayout(!!assistant?.open, close);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const providerRequest = useRef(0);
  const running = session?.status === 'running';
  const windowBusy = sessions.some((item) => item.status === 'running');
  const accept = useCallback((next: AssistantSession) => {
    setSessions((previous) =>
      [
        { ...next, messages: [] },
        ...previous.filter((item) => item.id !== next.id),
      ].sort((a, b) => b.updatedAt - a.updatedAt),
    );
    if (selected.current === next.id) setSession(next);
  }, []);
  const selectSession = async (id: string, keepHistoryOpen = false) => {
    draftEpoch.current++;
    setAttachments([]);
    if (!keepHistoryOpen) setHistoryOpen(false);
    selected.current = id;
    setInput('');
    follow.current = true;
    setDeleteConfirm(undefined);
    setDeleteError('');
    setError('');
    setSession(undefined);
    if (!id) return;
    try {
      const next = await window.ipc.invoke('assistant:get', { id });
      if (selected.current !== id) return;
      setSession(next);
      setProviderId(next.providerId);
      localStorage.setItem('assistant:lastSession', id);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const deleteSession = async (id: string) => {
    if (deleting || submitting) return;
    setDeleting(id);
    setDeleteError('');
    try {
      await window.ipc.invoke('assistant:delete', { id });
      setSessions((previous) => previous.filter((item) => item.id !== id));
      if (selected.current === id) await selectSession('', true);
      if (localStorage.getItem('assistant:lastSession') === id)
        localStorage.removeItem('assistant:lastSession');
      setDeleteConfirm(undefined);
    } catch (cause) {
      setDeleteError(String(cause));
    } finally {
      setDeleting(undefined);
    }
  };
  const loadProviders = useCallback(async () => {
    const request = ++providerRequest.current;
    const values = await window.ipc.invoke('assistant:providers');
    if (request !== providerRequest.current) return;
    setProviders(values);
    setProviderId((previous) => previous || values[0]?.id || '');
  }, []);
  useEffect(() => {
    if (!assistant?.open) return;
    void loadProviders().catch((cause) => setError(String(cause)));
    void window.ipc
      .invoke('assistant:list')
      .then((values) => {
        setSessions(values);
        if (!selected.current) {
          const previous = localStorage.getItem('assistant:lastSession');
          const first =
            values.find((item) => item.id === previous) || values[0];
          if (first) void selectSession(first.id);
        }
      })
      .catch((cause) => setError(String(cause)));
  }, [assistant?.open, loadProviders]);
  useEffect(
    () =>
      window.ipc?.on?.('assistant:event', (event: AssistantRunEvent) => {
        if (event.type === 'session') accept(event.session);
        else if (event.type === 'delta' && event.sessionId === selected.current)
          setSession(
            (previous) =>
              previous && {
                ...previous,
                messages: previous.messages.map((message) =>
                  message.id === event.messageId
                    ? { ...message, content: message.content + event.text }
                    : message,
                ),
              },
          );
        else if (event.type === 'changed') void loadProviders().catch(() => {});
      }),
    [accept, loadProviders],
  );
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [session, assistant?.open]);
  const newSession = async () => {
    try {
      const next = await window.ipc.invoke('assistant:create', { providerId });
      selected.current = next.id;
      accept(next);
      setInput('');
      setError('');
      setDeleteConfirm(undefined);
      setDeleteError('');
      setHistoryOpen(false);
      localStorage.setItem('assistant:lastSession', next.id);
      return next as AssistantSession;
    } catch (cause) {
      setError(String(cause));
      return undefined;
    }
  };
  const beginNewSession = async () => {
    if (await newSession()) {
      draftEpoch.current++;
      setAttachments([]);
    }
  };
  useEffect(() => {
    if (assistant?.open) chatInput.current?.focus({ preventScroll: true });
  }, [assistant?.open]);
  useEffect(() => {
    if (!assistant?.open) {
      setHistoryOpen(false);
      setDragging(false);
      dragDepth.current = 0;
    }
  }, [assistant?.open]);
  useEffect(() => {
    if (historyOpen)
      historyRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [historyOpen]);
  const importFiles = async (paths: string[]) => {
    if (importFlight.current || submitting) return;
    if (paths.length + attachments.length > ASSISTANT_MAX_ATTACHMENTS) {
      setError(t('assistant.attachmentLimit'));
      return;
    }
    if (!paths.length || paths.some((path) => !path)) {
      setError(t('assistant.attachmentFailed'));
      return;
    }
    const epoch = draftEpoch.current;
    importFlight.current = true;
    setImporting(true);
    setError('');
    try {
      const result = await window.ipc.invoke('assistant:attachments', {
        paths,
      });
      if (epoch !== draftEpoch.current) return;
      setAttachments((previous) =>
        [...previous, ...result.attachments].slice(
          0,
          ASSISTANT_MAX_ATTACHMENTS,
        ),
      );
      if (result.errors.length)
        setError(
          result.errors
            .map(
              (error) =>
                `${error.name}: ${t(`assistant.attachmentErrors.${['ATTACHMENT_TOO_LARGE', 'ATTACHMENT_NOT_FILE', 'ATTACHMENT_UNSUPPORTED'].includes(error.code) ? error.code : 'unreadable'}`)}`,
            )
            .join('\n'),
        );
    } catch {
      if (epoch === draftEpoch.current)
        setError(t('assistant.attachmentFailed'));
    } finally {
      importFlight.current = false;
      setImporting(false);
    }
  };
  const importDroppedFiles = (files: FileList | File[]) => {
    try {
      void importFiles(
        Array.from(files).map(
          (file) =>
            window.ipc.getPathForFile?.(file) || (file as any).path || '',
        ),
      );
    } catch {
      setError(t('assistant.attachmentFailed'));
    }
  };
  const [capturingScreen, setCapturingScreen] = useState(false);
  const captureScreen = async () => {
    if (
      capturingScreen ||
      importing ||
      submitting ||
      attachments.length >= ASSISTANT_MAX_ATTACHMENTS
    )
      return;
    const epoch = draftEpoch.current;
    setCapturingScreen(true);
    setError('');
    try {
      const attachment = await window.ipc.invoke('assistant:capture-screen', {
        region: 'workspace',
      });
      if (epoch !== draftEpoch.current) return;
      if (attachment) {
        setAttachments((previous) =>
          [...previous, attachment].slice(0, ASSISTANT_MAX_ATTACHMENTS),
        );
      }
    } catch {
      if (epoch === draftEpoch.current)
        setError(t('assistant.screenshotFailed'));
    } finally {
      setCapturingScreen(false);
    }
  };
  const send = async () => {
    if (
      (!input.trim() && !attachments.length) ||
      importing ||
      submitting ||
      windowBusy ||
      !providers.some((provider) => provider.id === providerId)
    )
      return;
    setSubmitting(true);
    setError('');
    follow.current = true;
    const text = input.trim() || t('assistant.analyzeAttachments');
    const sentAttachments = attachments;
    const epoch = draftEpoch.current;
    const context = attachContext ? assistant?.capture() : undefined;
    try {
      const current = session || (await newSession());
      if (!current) return;
      await window.ipc.invoke('assistant:start', {
        id: current.id,
        providerId,
        text,
        context,
        attachmentIds: sentAttachments.map((file) => file.id),
      });
      if (epoch === draftEpoch.current) {
        setInput('');
        setAttachments([]);
      }
    } catch (cause) {
      if (epoch === draftEpoch.current) setInput(text);
      setError(String(cause));
    } finally {
      setSubmitting(false);
    }
  };
  if (!assistant?.open) return null;
  const context = assistant.context;
  const selectedProviderExists = providers.some(
    (provider) => provider.id === providerId,
  );
  return (
    <aside
      ref={layout.panel}
      aria-label={t('assistant.title')}
      data-testid="assistant-panel"
      onClick={(event) => event.stopPropagation()}
      style={{ width: layout.width }}
      className="fixed bottom-[26px] right-0 top-11 z-30 flex max-w-[calc(100vw-64px)] flex-col border-l bg-background shadow-2xl min-[1440px]:relative min-[1440px]:bottom-auto min-[1440px]:top-auto min-[1440px]:z-auto min-[1440px]:h-full min-[1440px]:shrink-0 min-[1440px]:shadow-none"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.stopPropagation();
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        importDroppedFiles(event.dataTransfer.files);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          if (historyOpen) {
            setHistoryOpen(false);
            historyToggle.current?.focus();
          } else close();
        }
      }}
    >
      <div
        role="separator"
        aria-label={t('assistant.resize')}
        aria-orientation="vertical"
        aria-valuemin={360}
        aria-valuemax={layout.maximum}
        aria-valuenow={layout.width}
        tabIndex={0}
        onPointerDown={layout.startResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            layout.updateWidth(
              layout.width + (event.key === 'ArrowLeft' ? 24 : -24),
            );
          }
        }}
        className="absolute -left-1 top-0 z-40 h-full w-2 cursor-col-resize touch-none hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-none"
      />
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <Button
          ref={historyToggle}
          variant="ghost"
          size="icon"
          aria-label={t('assistant.history')}
          aria-expanded={historyOpen}
          aria-controls="assistant-history"
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          <Menu className="h-4 w-4" />
        </Button>
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{t('assistant.title')}</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {session?.title || t('assistant.new')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          disabled={submitting}
          title={t('assistant.new')}
          aria-label={t('assistant.new')}
          onClick={() => void beginNewSession()}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={t('assistant.close')}
          aria-label={t('assistant.close')}
          onClick={close}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {historyOpen && (
          <div
            className="absolute inset-0 z-20 flex"
            data-testid="assistant-history-overlay"
          >
            <button
              className="absolute inset-0 bg-black/20"
              aria-label={t('assistant.closeHistory')}
              onClick={() => {
                setHistoryOpen(false);
                historyToggle.current?.focus();
              }}
            />
            <div
              ref={historyRef}
              id="assistant-history"
              aria-label={t('assistant.history')}
              className="relative flex h-full w-[280px] max-w-[85%] flex-col border-r bg-background shadow-xl animate-in slide-in-from-left-4 duration-200"
            >
              <div className="flex items-center justify-between border-b p-3">
                <h3 className="text-sm font-semibold">
                  {t('assistant.history')}
                </h3>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('assistant.closeHistory')}
                  onClick={() => {
                    setHistoryOpen(false);
                    historyToggle.current?.focus();
                  }}
                >
                  <PanelLeftClose className="h-4 w-4" />
                </Button>
              </div>
              <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                {!sessions.length && (
                  <p className="p-3 text-xs text-muted-foreground">
                    {t('assistant.emptyHistory')}
                  </p>
                )}
                {sessions.map((item) => (
                  <div
                    key={item.id}
                    data-session-id={item.id}
                    className={`rounded-lg text-xs transition-colors ${item.id === session?.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted'}`}
                  >
                    <div className="flex items-center pr-2">
                      <button
                        disabled={submitting}
                        aria-current={
                          item.id === session?.id ? 'page' : undefined
                        }
                        onClick={() => void selectSession(item.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {item.status === 'running' ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                        ) : (
                          <MessageSquare className="h-4 w-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">
                            {item.title || t('assistant.new')}
                          </span>
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            {new Date(item.updatedAt).toLocaleDateString()}
                          </span>
                        </span>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="shrink-0 hover:bg-destructive/10 hover:text-destructive"
                        title={t('assistant.delete')}
                        aria-label={`${t('assistant.delete')} · ${item.title || t('assistant.new')}`}
                        disabled={
                          item.status === 'running' || submitting || !!deleting
                        }
                        onClick={() => {
                          setDeleteConfirm(
                            deleteConfirm === item.id ? undefined : item.id,
                          );
                          setDeleteError('');
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {deleteConfirm === item.id && (
                      <div className="space-y-2 border-t px-3 py-3 text-foreground">
                        <p className="text-muted-foreground">
                          {t('assistant.deleteHint')}
                        </p>
                        {deleteError && (
                          <p
                            role="alert"
                            className="break-words text-destructive"
                          >
                            {deleteError}
                          </p>
                        )}
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!!deleting}
                            onClick={() => {
                              setDeleteConfirm(undefined);
                              setDeleteError('');
                            }}
                          >
                            {t('cancel')}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={
                              item.status === 'running' ||
                              submitting ||
                              !!deleting
                            }
                            onClick={() => void deleteSession(item.id)}
                          >
                            {deleting === item.id && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            )}
                            {t('assistant.delete')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </nav>
            </div>
          </div>
        )}
        <div
          ref={scroll}
          className="min-h-0 flex-1 space-y-6 overflow-x-hidden overflow-y-auto px-5 py-6"
          onScroll={() => {
            const el = scroll.current;
            if (el)
              follow.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {!session?.messages.length && (
            <div className="flex min-h-full flex-col justify-center gap-5 pb-6 text-sm">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xl font-semibold tracking-tight">
                  {t('assistant.welcome')}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {t('assistant.description')}
                </p>
              </div>
              <div className="space-y-2">
                {['exampleEdit', 'exampleTask', 'exampleModels'].map((key) => (
                  <button
                    key={key}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border p-3.5 text-left text-xs transition-colors hover:bg-muted"
                    onClick={() => setInput(t(`assistant.${key}`))}
                  >
                    {t(`assistant.${key}`)}
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {session?.messages.map((message) => (
            <Message key={message.id} message={message} onError={setError} />
          ))}
          {running && (
            <div
              role="status"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('assistant.working')}
            </div>
          )}
          {session && ['interrupted', 'limited'].includes(session.status) && (
            <p
              role="status"
              className="text-xs leading-5 text-muted-foreground"
            >
              {t(`assistant.${session.status}`)}
            </p>
          )}
          <div ref={bottom} />
        </div>
        {(error || session?.error) && (
          <div
            role="alert"
            className="mx-3 mb-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-destructive/10 p-3 text-xs text-destructive"
          >
            {error || session?.error}
          </div>
        )}
        <div className="shrink-0 px-3 pb-3">
          <label className="mb-2 flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={attachContext}
              onChange={(event) => setAttachContext(event.target.checked)}
            />
            {t('assistant.context')}
            <span
              className="min-w-0 flex-1 truncate"
              title={context.files?.join('\n')}
            >
              {attachContext &&
                (context.files?.[0]?.split(/[\\/]/).pop() ||
                  context.page.split('/').filter(Boolean).pop())}
              {attachContext &&
                context.editor &&
                ` · ${t('assistant.line', { index: context.editor.selectedIndex + 1 })}${context.editor.dirty ? ` · ${t('assistant.draft')}` : ''}`}
              {attachContext &&
                Boolean(context.recentErrors?.length) &&
                ` · ${t('assistant.hasErrors')}`}
            </span>
          </label>
          <div className="rounded-2xl border bg-muted/20 p-2 shadow-sm focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
            {attachments.length > 0 && (
              <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto p-1 pb-2">
                {attachments.map((file) => (
                  <div
                    key={file.id}
                    data-testid="assistant-attachment"
                    className="flex max-w-full items-center gap-2 rounded-xl border bg-background py-2 pl-2.5 pr-1"
                  >
                    <AttachmentIcon kind={file.kind} />
                    <span className="min-w-0">
                      <span
                        className="block max-w-48 truncate text-xs font-medium"
                        title={file.path}
                      >
                        {file.name}
                      </span>
                      <span className="block text-[10px] text-muted-foreground">
                        {t(`assistant.attachmentKind.${file.kind}`)} ·{' '}
                        {file.size < 1024 * 1024
                          ? `${Math.max(1, Math.round(file.size / 1024))} KB`
                          : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      disabled={submitting}
                      aria-label={t('assistant.removeAttachment', {
                        name: file.name,
                      })}
                      onClick={() =>
                        setAttachments((previous) =>
                          previous.filter((item) => item.id !== file.id),
                        )
                      }
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={chatInput}
              aria-label={t('assistant.input')}
              placeholder={t('assistant.placeholder')}
              disabled={submitting}
              className="min-h-24 w-full resize-none bg-transparent px-2 py-2 text-sm leading-6 placeholder:text-muted-foreground/70 focus:outline-none"
              rows={3}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={ASSISTANT_ATTACHMENT_ACCEPT}
                multiple
                className="hidden"
                aria-label={t('assistant.attach')}
                onChange={(event) => {
                  if (event.target.files?.length)
                    importDroppedFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={t('assistant.attach')}
                title={t('assistant.attachmentHint')}
                disabled={
                  importing ||
                  submitting ||
                  attachments.length >= ASSISTANT_MAX_ATTACHMENTS
                }
                onClick={() => fileInput.current?.click()}
              >
                {importing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={t('assistant.captureScreen')}
                title={t('assistant.captureScreen')}
                disabled={
                  capturingScreen ||
                  importing ||
                  submitting ||
                  attachments.length >= ASSISTANT_MAX_ATTACHMENTS
                }
                onClick={() => void captureScreen()}
              >
                {capturingScreen ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
              </Button>
              <select
                aria-label={t('assistant.service')}
                className="ml-auto h-8 min-w-0 flex-1 cursor-pointer rounded-lg border-0 bg-transparent px-2 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                disabled={running || submitting}
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
              >
                {!selectedProviderExists && (
                  <option value={providerId}>
                    {t('assistant.chooseService')}
                  </option>
                )}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} · {provider.modelName}
                  </option>
                ))}
              </select>
              {running ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 rounded-xl"
                  onClick={() =>
                    void window.ipc
                      .invoke('assistant:stop', { id: session!.id })
                      .catch((cause) => setError(String(cause)))
                  }
                >
                  <Square className="mr-1.5 h-3 w-3" />
                  {t('assistant.stop')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="shrink-0 rounded-xl"
                  disabled={
                    (!input.trim() && !attachments.length) ||
                    !selectedProviderExists ||
                    importing ||
                    submitting ||
                    windowBusy
                  }
                  onClick={() => void send()}
                >
                  <ArrowUp className="mr-1.5 h-3.5 w-3.5" />
                  {t('assistant.send')}
                </Button>
              )}
            </div>
          </div>
          {!selectedProviderExists ? (
            <button
              className="mt-2 text-left text-xs text-primary hover:underline"
              onClick={() =>
                void router.push(`/${router.query.locale || 'zh'}/translation`)
              }
            >
              {t('assistant.configure')}
            </button>
          ) : (
            <p className="mt-2 text-center text-[10px] text-muted-foreground">
              {t('assistant.inputHint', {
                shortcut: isMacPlatform() ? '⌘J' : 'Ctrl+J',
              })}
            </p>
          )}
        </div>
      </div>
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-background/95 text-primary">
          <Upload className="h-8 w-8" />
          <p className="text-sm font-medium">{t('assistant.dropFiles')}</p>
          <p className="px-5 text-center text-xs text-muted-foreground">
            {t('assistant.attachmentHint')}
          </p>
        </div>
      )}
    </aside>
  );
}

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/router';
import { useHotkeys } from '../hooks/useHotkeys';
import type {
  AssistantContextSnapshot,
  EditorCommand,
  EditorCommandResult,
} from '../../types/assistant';

export interface AssistantContextSource {
  priority: number;
  snapshot(): Partial<AssistantContextSnapshot>;
  execute?(command: EditorCommand): Promise<EditorCommandResult>;
}
interface AssistantContextValue {
  open: boolean;
  setOpen(open: boolean): void;
  context: AssistantContextSnapshot;
  capture(): AssistantContextSnapshot;
  register(key: symbol, source: AssistantContextSource): () => void;
  notify(): void;
}
const Context = createContext<AssistantContextValue | null>(null);
export const useAssistant = () => useContext(Context);

interface RecentError {
  message: string;
  projectId?: string;
  timestamp: number;
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const route = useRef(router);
  route.current = router;
  const sources = useRef(new Map<symbol, AssistantContextSource>());
  const recentErrorsRef = useRef<RecentError[]>([]);
  const [open, setOpen] = useState(false);
  useHotkeys([
    {
      combo: 'mod+j',
      allowInInput: true,
      handler: () => setOpen((previous) => !previous),
    },
  ]);
  const capture = useCallback((): AssistantContextSnapshot => {
    const { asPath, query } = route.current;
    const base: AssistantContextSnapshot = {
      page: asPath || '',
      capturedAt: Date.now(),
      projectId:
        typeof query.project === 'string'
          ? query.project
          : typeof query.workItem === 'string'
            ? query.workItem
            : undefined,
      sessionId: typeof query.session === 'string' ? query.session : undefined,
      files: ['video', 'subtitle', 'proofreadData'].flatMap((key) =>
        typeof query[key] === 'string' ? [query[key] as string] : [],
      ),
    };
    const source = Array.from(sources.current.values()).sort(
      (a, b) => b.priority - a.priority,
    )[0];
    const sourceSnapshot = source ? source.snapshot() : {};
    const effectiveProjectId = sourceSnapshot.projectId || base.projectId;
    const projectErrors = effectiveProjectId
      ? recentErrorsRef.current.filter(
          (entry) => entry.projectId === effectiveProjectId,
        )
      : [];
    const pool =
      projectErrors.length > 0 ? projectErrors : recentErrorsRef.current;
    const rawErrors = [
      ...(sourceSnapshot.recentErrors || []),
      ...pool.map((entry) => entry.message),
    ];
    const recentErrors = Array.from(new Set(rawErrors.filter(Boolean))).slice(
      0,
      5,
    );
    return {
      ...base,
      ...sourceSnapshot,
      ...(recentErrors.length ? { recentErrors } : {}),
    };
  }, []);
  const [context, setContext] = useState<AssistantContextSnapshot>({
    page: '',
    capturedAt: 0,
  });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const notify = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const next = capture();
      setContext(next);
      void window.ipc?.invoke('assistant:context', next).catch(() => {});
    }, 100);
  }, [capture]);
  const register = useCallback(
    (key: symbol, source: AssistantContextSource) => {
      sources.current.set(key, source);
      notify();
      return () => {
        sources.current.delete(key);
        notify();
      };
    },
    [notify],
  );
  useEffect(() => {
    notify();
  }, [router.asPath, notify]);
  useEffect(() => {
    const unsub = window.ipc?.on?.(
      'newLog',
      (log: {
        message?: string;
        type?: string;
        projectId?: string;
        timestamp?: number;
      }) => {
        if (log?.type !== 'error') return;
        const message = String(log.message || '')
          .trim()
          .slice(0, 2000);
        if (!message) return;
        const entry: RecentError = {
          message,
          projectId: log.projectId,
          timestamp: log.timestamp || Date.now(),
        };
        const existing = recentErrorsRef.current;
        const seen = new Set(
          existing.map((e) => `${e.timestamp}:${e.message}`),
        );
        if (!seen.has(`${entry.timestamp}:${entry.message}`)) {
          recentErrorsRef.current = [entry, ...existing].slice(0, 10);
          notify();
        }
      },
    );
    return () => {
      unsub?.();
    };
  }, [notify]);
  const currentProjectId =
    typeof router.query.project === 'string'
      ? router.query.project
      : typeof router.query.workItem === 'string'
        ? router.query.workItem
        : undefined;
  useEffect(() => {
    if (!currentProjectId) return;
    let active = true;
    void window.ipc
      ?.invoke?.('getLogs', {
        projectId: currentProjectId,
        types: ['error'],
        limit: 5,
      })
      ?.then((entries: any[]) => {
        if (!active || !Array.isArray(entries) || !entries.length) return;
        const fetched: RecentError[] = entries
          .map((entry) => ({
            message: String(entry.message || '')
              .trim()
              .slice(0, 2000),
            projectId: currentProjectId,
            timestamp: entry.timestamp || Date.now(),
          }))
          .filter((entry) => Boolean(entry.message));
        const existing = recentErrorsRef.current;
        const seen = new Set(
          existing.map((e) => `${e.timestamp}:${e.message}`),
        );
        const added = fetched.filter(
          (entry) => !seen.has(`${entry.timestamp}:${entry.message}`),
        );
        if (added.length) {
          recentErrorsRef.current = [...added, ...existing].slice(0, 10);
          notify();
        }
      })
      ?.catch(() => {});
    return () => {
      active = false;
    };
  }, [currentProjectId, notify]);
  useEffect(() => {
    const unsub = window.ipc?.on?.(
      'assistant:editor-command',
      async (command: EditorCommand) => {
        try {
          const source = Array.from(sources.current.values()).find(
            (candidate) =>
              candidate.execute &&
              candidate.snapshot().editor?.documentId === command.documentId,
          );
          if (!source?.execute) throw new Error('EDITOR_UNAVAILABLE');
          const result = await source.execute(command);
          result.context = {
            ...capture(),
            ...result.context,
            page: route.current.asPath,
          };
          await window.ipc.invoke('assistant:editor-result', {
            id: command.id,
            result,
          });
          notify();
        } catch (error) {
          await window.ipc
            .invoke('assistant:editor-result', {
              id: command.id,
              error: String(error),
            })
            .catch(() => {});
        }
      },
    );
    return () => {
      unsub?.();
      clearTimeout(timer.current);
      void window.ipc?.invoke('assistant:context', null).catch(() => {});
    };
  }, [capture, notify]);
  return (
    <Context.Provider
      value={{ open, setOpen, context, capture, register, notify }}
    >
      {children}
    </Context.Provider>
  );
}

export function useAssistantSource(
  source: AssistantContextSource,
  dependencies: React.DependencyList,
) {
  const assistant = useAssistant();
  const latest = useRef(source);
  latest.current = source;
  const register = assistant?.register;
  const notify = assistant?.notify;
  useEffect(
    () =>
      register?.(Symbol('workspace'), {
        priority: source.priority,
        snapshot: () => latest.current.snapshot(),
        execute: source.execute
          ? (command) => latest.current.execute!(command)
          : undefined,
      }),
    [register, source.priority, !!source.execute],
  );
  useEffect(() => {
    notify?.();
  }, [notify, ...dependencies]);
}

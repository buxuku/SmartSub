import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Save, Undo2 } from 'lucide-react';
import { saveNavigationGuards } from '../lib/navigationSave';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export interface NavigationGuardOptions {
  isDirty: boolean;
  getIsDirty?: () => boolean;
  onSave?: () => Promise<boolean>;
  onDiscard?: () => void | boolean | Promise<void | boolean>;
  title?: string;
  description?: string;
  stayLabel?: string;
  discardLabel?: string;
}

export interface NavigationGuardContextValue {
  registerGuard: (id: string, options: NavigationGuardOptions) => void;
  unregisterGuard: (id: string) => void;
  isGuarded: boolean;
  isDialogOpen: boolean;
  bypassNextRoute: () => void;
}

const NavigationGuardContext =
  createContext<NavigationGuardContextValue | null>(null);

const NAVIGATION_CANCEL_CODE = 'SMARTSUB_UNSAVED_NAVIGATION';

const normalizePath = (p?: string | null): string => {
  if (!p) return '/';
  const url = new URL(p, 'http://smartsub.local');
  return (url.pathname.replace(/\/+$/, '') || '/') + url.search;
};

export function NavigationGuardProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { t } = useTranslation('common');

  const guardsRef = useRef<Map<string, NavigationGuardOptions>>(new Map());
  const [dirtyCount, setDirtyCount] = useState(0);
  const [showDialog, setShowDialog] = useState(false);
  const [dialogCanSave, setDialogCanSave] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveChanged, setSaveChanged] = useState(false);
  const [discardFailed, setDiscardFailed] = useState(false);
  const bypassRef = useRef(false);
  const historyIndexRef = useRef(0);
  const restoringHistoryRef = useRef(false);
  const pendingHistoryRef = useRef<number | null>(null);
  const [restoringHistory, setRestoringHistory] = useState(false);

  useEffect(() => {
    // Next Link leaves the rejected route promise unhandled. Suppress only our
    // intentional cancellation so the development overlay cannot cover the dialog.
    const handleRejection = (event: PromiseRejectionEvent) => {
      if (event.reason?.code !== NAVIGATION_CANCEL_CODE) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('unhandledrejection', handleRejection, true);
    return () =>
      window.removeEventListener('unhandledrejection', handleRejection, true);
  }, []);

  useEffect(() => {
    const history = window.history;
    const push = history.pushState;
    const replace = history.replaceState;
    const initialIndex = history.state?.smartsubGuardIndex ?? 0;
    historyIndexRef.current = initialIndex;
    replace.call(
      history,
      { ...history.state, smartsubGuardIndex: initialIndex },
      '',
    );
    history.pushState = function (data, unused, url) {
      const index = historyIndexRef.current + 1;
      push.call(history, { ...data, smartsubGuardIndex: index }, unused, url);
      historyIndexRef.current = index;
    };
    history.replaceState = function (data, unused, url) {
      replace.call(
        history,
        { ...data, smartsubGuardIndex: historyIndexRef.current },
        unused,
        url,
      );
    };
    return () => {
      history.pushState = push;
      history.replaceState = replace;
    };
  }, []);

  const updateDirtyCount = useCallback(() => {
    let count = 0;
    guardsRef.current.forEach((guard) => {
      if (guard.isDirty) count += 1;
    });
    setDirtyCount(count);
  }, []);

  const registerGuard = useCallback(
    (id: string, options: NavigationGuardOptions) => {
      guardsRef.current.set(id, options);
      updateDirtyCount();
    },
    [updateDirtyCount],
  );

  const unregisterGuard = useCallback(
    (id: string) => {
      guardsRef.current.delete(id);
      updateDirtyCount();
    },
    [updateDirtyCount],
  );

  const getActiveDirtyGuard = useCallback((): NavigationGuardOptions | null => {
    let dirtyGuard: NavigationGuardOptions | null = null;
    guardsRef.current.forEach((guard) => {
      if (!dirtyGuard && (guard.getIsDirty?.() ?? guard.isDirty)) {
        dirtyGuard = guard;
      }
    });
    return dirtyGuard;
  }, []);

  const isGuarded = dirtyCount > 0;

  useEffect(() => {
    window.ipc?.send('setUnsavedChanges', isGuarded);
  }, [isGuarded]);

  const bypassNextRoute = useCallback(() => {
    bypassRef.current = true;
  }, []);

  // 1. 窗口关闭 / 刷新保护 (beforeunload)
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (getActiveDirtyGuard()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [getActiveDirtyGuard]);

  // 2. Next.js 客户端路由切换保护 (routeChangeStart)
  useEffect(() => {
    const handleRouteChangeStart = (url: string) => {
      if (bypassRef.current) {
        bypassRef.current = false;
        return;
      }

      const activeGuard = getActiveDirtyGuard();
      if (!activeGuard) return;

      // 规范化路径比对，忽略尾随斜杠差异 (e.g. /zh/home vs /zh/home/)
      if (normalizePath(url) === normalizePath(router.asPath)) return;

      // 阻止 Next.js 切换页面，携带标准 { cancelled: true } payload
      // Cancellation is a control-flow signal, not a runtime Error. Next's
      // development listener runs before ours and renders Error instances.
      const err = { cancelled: true, code: NAVIGATION_CANCEL_CODE };
      router.events.emit('routeChangeError', err, url, { shallow: false });
      setPendingUrl(url);
      setDialogCanSave(Boolean(activeGuard.onSave));
      pendingHistoryRef.current = null;
      setShowDialog(true);
      throw err;
    };

    router.events.on('routeChangeStart', handleRouteChangeStart);
    return () => {
      router.events.off('routeChangeStart', handleRouteChangeStart);
    };
  }, [router, getActiveDirtyGuard]);

  // 3. 浏览器前进/后退拦截 (beforePopState)
  useEffect(() => {
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    const restoreCurrentEntry = () => {
      clearTimeout(restoreTimer);
      // Coalesce queued back/forward gestures before issuing another traversal.
      restoreTimer = setTimeout(() => {
        const current = window.history.state?.smartsubGuardIndex;
        if (
          typeof current === 'number' &&
          current !== historyIndexRef.current
        ) {
          window.history.go(historyIndexRef.current - current);
          return;
        }
        restoringHistoryRef.current = false;
        setRestoringHistory(false);
      }, 30);
    };
    router.beforePopState(({ url, as }) => {
      const targetIndex = window.history.state?.smartsubGuardIndex;
      if (restoringHistoryRef.current) {
        restoreCurrentEntry();
        return false;
      }
      if (bypassRef.current) {
        if (typeof targetIndex === 'number')
          historyIndexRef.current = targetIndex;
        return true;
      }

      const activeGuard = getActiveDirtyGuard();
      if (!activeGuard) {
        if (typeof targetIndex === 'number')
          historyIndexRef.current = targetIndex;
        return true;
      }

      // 优先记录真实的展示 URL (as)，避免 [locale] 动态路由或 trailingSlash 导致跳转失真
      const target = as || url;
      if (normalizePath(target) === normalizePath(router.asPath)) {
        if (typeof targetIndex === 'number')
          historyIndexRef.current = targetIndex;
        return true;
      }

      const delta =
        typeof targetIndex === 'number'
          ? historyIndexRef.current - targetIndex
          : 0;
      pendingHistoryRef.current = delta ? targetIndex : null;
      if (delta) {
        restoringHistoryRef.current = true;
        setRestoringHistory(true);
        restoreCurrentEntry();
      } else {
        window.history.replaceState(window.history.state, '', router.asPath);
      }
      setPendingUrl(target);
      setDialogCanSave(Boolean(activeGuard.onSave));
      setShowDialog(true);
      return false;
    });

    return () => {
      clearTimeout(restoreTimer);
      router.beforePopState(() => true);
    };
  }, [router, getActiveDirtyGuard]);

  // 4. 监听 routeChangeError，静默正常取消的路由以消除控制台噪音
  useEffect(() => {
    const handleRouteChangeError = (err: any) => {
      if (err?.cancelled) {
        return;
      }
    };
    router.events.on('routeChangeError', handleRouteChangeError);
    return () => {
      router.events.off('routeChangeError', handleRouteChangeError);
    };
  }, [router]);

  const handleCancel = () => {
    setSaveChanged(false);
    setDiscardFailed(false);
    setShowDialog(false);
    setPendingUrl(null);
    pendingHistoryRef.current = null;
  };

  const leave = () => {
    const target = pendingUrl;
    const targetIndex = pendingHistoryRef.current;
    pendingHistoryRef.current = null;
    setPendingUrl(null);
    setShowDialog(false);
    if (!target) return;
    bypassRef.current = true;
    if (targetIndex !== null)
      window.history.go(targetIndex - historyIndexRef.current);
    else
      void router.push(target).finally(() => {
        bypassRef.current = false;
      });
  };

  const handleDiscardAndLeave = async () => {
    setIsSaving(true);
    try {
      for (const guard of Array.from(guardsRef.current.values())) {
        if (!(guard.getIsDirty?.() ?? guard.isDirty)) continue;
        try {
          if ((await guard.onDiscard?.()) === false) {
            setDiscardFailed(true);
            return;
          }
        } catch {
          setDiscardFailed(true);
          return;
        }
      }
      setDiscardFailed(false);
      leave();
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAndLeave = async () => {
    const activeGuard = getActiveDirtyGuard();
    if (!activeGuard) {
      leave();
      return;
    }

    if (!activeGuard.onSave) {
      console.warn(
        'Navigation guard: save requested but no onSave handler provided',
      );
      return;
    }

    setIsSaving(true);
    setSaveChanged(false);
    try {
      const result = await saveNavigationGuards(guardsRef.current);
      if (result !== 'saved') {
        setSaveChanged(result === 'changed');
        setIsSaving(false);
        return;
      }
    } catch (err) {
      console.error('Save failed during navigation guard:', err);
      setIsSaving(false);
      return;
    }

    setIsSaving(false);
    leave();
  };

  const activeGuard = getActiveDirtyGuard();

  return (
    <NavigationGuardContext.Provider
      value={{
        registerGuard,
        unregisterGuard,
        isGuarded,
        isDialogOpen: showDialog,
        bypassNextRoute,
      }}
    >
      {children}
      <AlertDialog
        open={showDialog}
        onOpenChange={(open) => {
          if (!open) {
            if (!isSaving && !restoringHistory) handleCancel();
          } else {
            setShowDialog(true);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {activeGuard?.title || t('navigationGuard.title', '未保存的修改')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {activeGuard?.description ||
                t(
                  'navigationGuard.desc',
                  '当前页面有尚未保存的内容，离开将丢失未保存的改动。是否先保存？',
                )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {saveChanged && (
            <p role="alert" className="text-sm text-destructive">
              {t('navigationGuard.changedDuringSave')}
            </p>
          )}
          {discardFailed && (
            <p role="alert" className="text-sm text-destructive">
              {t('navigationGuard.discardFailed')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isSaving || restoringHistory}
              onClick={handleCancel}
            >
              {activeGuard?.stayLabel ||
                t('navigationGuard.keepEditing', '留在当前页')}
            </AlertDialogCancel>
            <Button
              variant="outline"
              disabled={isSaving || restoringHistory}
              className="gap-1.5"
              onClick={handleDiscardAndLeave}
            >
              <Undo2 className="h-4 w-4" />
              {activeGuard?.discardLabel ||
                t('navigationGuard.discardAndLeave', '放弃并离开')}
            </Button>
            {(dialogCanSave || activeGuard?.onSave) && (
              <Button
                disabled={isSaving || restoringHistory}
                className="gap-1.5"
                onClick={handleSaveAndLeave}
              >
                <Save className="h-4 w-4" />
                {isSaving
                  ? t('navigationGuard.saving', '保存中...')
                  : t('navigationGuard.saveAndLeave', '保存并离开')}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </NavigationGuardContext.Provider>
  );
}

export function useNavigationGuard(
  id: string,
  options: NavigationGuardOptions,
) {
  const context = useContext(NavigationGuardContext);
  const registerGuard = context?.registerGuard;
  const unregisterGuard = context?.unregisterGuard;

  // 在 useLayoutEffect 中注册与同步 options，保证在 paint 与用户事件前执行，避免 render 阶段触发 setState
  useIsomorphicLayoutEffect(() => {
    if (!registerGuard) return;
    registerGuard(id, options);
  }, [
    registerGuard,
    unregisterGuard,
    id,
    options.isDirty,
    options.getIsDirty,
    options.onSave,
    options.onDiscard,
    options.title,
    options.description,
  ]);
  useIsomorphicLayoutEffect(
    () => () => unregisterGuard?.(id),
    [id, unregisterGuard],
  );

  return context;
}

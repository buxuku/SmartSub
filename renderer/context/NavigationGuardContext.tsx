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

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export interface NavigationGuardOptions {
  isDirty: boolean;
  onSave?: () => Promise<boolean>;
  title?: string;
  description?: string;
}

interface NavigationGuardContextValue {
  registerGuard: (id: string, options: NavigationGuardOptions) => void;
  unregisterGuard: (id: string) => void;
  isGuarded: boolean;
  bypassNextRoute: () => void;
}

const NavigationGuardContext =
  createContext<NavigationGuardContextValue | null>(null);

const normalizePath = (p?: string | null): string => {
  if (!p) return '/';
  const withoutQuery = p.split('?')[0];
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return trimmed || '/';
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
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const bypassRef = useRef(false);

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
      if (!dirtyGuard && guard.isDirty) {
        dirtyGuard = guard;
      }
    });
    return dirtyGuard;
  }, []);

  const isGuarded = dirtyCount > 0;

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
      const err = Object.assign(
        new Error('routeChange aborted (unsaved changes guard)'),
        { cancelled: true },
      );
      router.events.emit('routeChangeError', err, url, { shallow: false });
      setPendingUrl(url);
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
    router.beforePopState(({ url, as }) => {
      if (bypassRef.current) {
        bypassRef.current = false;
        return true;
      }

      const activeGuard = getActiveDirtyGuard();
      if (!activeGuard) return true;

      // 优先记录真实的展示 URL (as)，避免 [locale] 动态路由或 trailingSlash 导致跳转失真
      const target = as || url;
      if (normalizePath(target) === normalizePath(router.asPath)) {
        return true;
      }

      setPendingUrl(target);
      setShowDialog(true);
      return false;
    });

    return () => {
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
    setShowDialog(false);
    setPendingUrl(null);
    // 若浏览器地址栏因 popstate 已发生变更，平滑恢复回 router.asPath
    if (
      typeof window !== 'undefined' &&
      normalizePath(window.location.pathname) !== normalizePath(router.asPath)
    ) {
      window.history.pushState(null, '', router.asPath);
    }
  };

  const handleDiscardAndLeave = () => {
    setShowDialog(false);
    const target = pendingUrl;
    setPendingUrl(null);
    if (target) {
      bypassRef.current = true;
      router.push(target);
    }
  };

  const handleSaveAndLeave = async () => {
    const activeGuard = getActiveDirtyGuard();
    if (!activeGuard) {
      setShowDialog(false);
      setPendingUrl(null);
      return;
    }

    if (!activeGuard.onSave) {
      console.warn(
        'Navigation guard: save requested but no onSave handler provided',
      );
      return;
    }

    setIsSaving(true);
    try {
      const ok = await activeGuard.onSave();
      if (!ok) {
        // 保存失败保持弹窗展开，供用户重试或放弃
        setIsSaving(false);
        return;
      }
    } catch (err) {
      console.error('Save failed during navigation guard:', err);
      setIsSaving(false);
      return;
    }

    // 成功保存后直接将 guard 的 dirty 标志置为 false，消除竞态
    activeGuard.isDirty = false;
    updateDirtyCount();
    setIsSaving(false);

    setShowDialog(false);
    const target = pendingUrl;
    setPendingUrl(null);
    if (target) {
      bypassRef.current = true;
      router.push(target);
    }
  };

  const activeGuard = getActiveDirtyGuard();

  return (
    <NavigationGuardContext.Provider
      value={{
        registerGuard,
        unregisterGuard,
        isGuarded,
        bypassNextRoute,
      }}
    >
      {children}
      <AlertDialog
        open={showDialog}
        onOpenChange={(open) => {
          if (!open) {
            handleCancel();
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
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving} onClick={handleCancel}>
              {t('navigationGuard.keepEditing', '留在当前页')}
            </AlertDialogCancel>
            <Button
              variant="outline"
              disabled={isSaving}
              className="gap-1.5"
              onClick={handleDiscardAndLeave}
            >
              <Undo2 className="h-4 w-4" />
              {t('navigationGuard.discardAndLeave', '放弃并离开')}
            </Button>
            {activeGuard?.onSave && (
              <Button
                disabled={isSaving}
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

  // 在 useLayoutEffect 中注册与同步 options，保证在 paint 与用户事件前执行，避免 render 阶段触发 setState
  useIsomorphicLayoutEffect(() => {
    if (!context) return;
    context.registerGuard(id, options);
    return () => {
      context.unregisterGuard(id);
    };
  }, [
    context,
    id,
    options.isDirty,
    options.onSave,
    options.title,
    options.description,
  ]);

  return context;
}

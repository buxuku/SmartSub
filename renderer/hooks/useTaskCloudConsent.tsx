import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Cloud } from 'lucide-react';
import { Button } from '../components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';

/** All task entry points share the same privacy confirmation and cancellation. */
export function useTaskCloudConsent() {
  const { t } = useTranslation(['home', 'common']);
  const [open, setOpen] = useState(false);
  const mounted = useRef(false);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.(false);
      pending.current = null;
    };
  }, []);
  const finish = useCallback((confirmed: boolean) => {
    pending.current?.(confirmed);
    pending.current = null;
    setOpen(false);
  }, []);
  const requestConsent = useCallback(
    async (needsTranscription: boolean, engine?: string) => {
      if (!mounted.current) return false;
      if (!needsTranscription || engine !== 'cloud') return true;
      const settings = await window.ipc.invoke('getSettings');
      if (!mounted.current) return false;
      if (settings?.cloudUploadConsent === true) return true;
      pending.current?.(false);
      return new Promise<boolean>((resolve) => {
        pending.current = resolve;
        setOpen(true);
      });
    },
    [],
  );
  const confirm = async (remember: boolean) => {
    if (remember) {
      try {
        await window.ipc.invoke('setSettings', { cloudUploadConsent: true });
      } catch {
        /* Consent still applies once when remembering it fails. */
      }
    }
    finish(true);
  };
  return {
    requestConsent,
    dialog: (
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) finish(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Cloud className="h-5 w-5 text-info" />
              {t('home:cloudConsent.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('home:cloudConsent.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            <AlertDialogCancel onClick={() => finish(false)}>
              {t('common:cancel')}
            </AlertDialogCancel>
            <Button variant="outline" onClick={() => void confirm(false)}>
              {t('home:cloudConsent.confirmOnce')}
            </Button>
            <Button onClick={() => void confirm(true)}>
              {t('home:cloudConsent.confirmRemember')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}

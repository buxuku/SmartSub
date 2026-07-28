import React, { useEffect, useMemo, useState } from 'react';
import { Languages, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { supportedLanguage } from 'lib/utils';
import {
  CUSTOM_LANGUAGE_LIMIT,
  type CustomLanguage,
  sanitizeCustomLanguages,
  validateCustomLanguage,
} from '../../../types/language';

const builtInCodes = supportedLanguage.map((language) => language.value);

export default function CustomLanguageManager() {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [languages, setLanguages] = useState<CustomLanguage[]>([]);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    window?.ipc
      ?.invoke('getSettings')
      .then((settings) => {
        if (mounted) {
          setLanguages(
            sanitizeCustomLanguages(settings?.customLanguages, builtInCodes),
          );
        }
      })
      .catch(() => {
        if (mounted) setLanguages([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const sortedLanguages = useMemo(
    () =>
      [...languages].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
    [languages],
  );

  const persist = async (next: CustomLanguage[]) => {
    setSaving(true);
    try {
      const sanitized = sanitizeCustomLanguages(next, builtInCodes);
      await window?.ipc?.invoke('setSettings', { customLanguages: sanitized });
      setLanguages(sanitized);
      return true;
    } catch {
      toast.error(t('saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    if (languages.length >= CUSTOM_LANGUAGE_LIMIT) {
      toast.error(t('customLanguagesLimit', { count: CUSTOM_LANGUAGE_LIMIT }));
      return;
    }
    const error = validateCustomLanguage(
      { name, value: code },
      {
        builtInCodes,
        existingCustomLanguages: languages,
      },
    );
    if (error) {
      toast.error(t(`customLanguageErrors.${error}`));
      return;
    }
    const next = [...languages, { name: name.trim(), value: code.trim() }];
    if (await persist(next)) {
      setName('');
      setCode('');
      toast.success(t('customLanguageAdded'));
    }
  };

  const handleRemove = async (value: string) => {
    const next = languages.filter(
      (language) => language.value.toLowerCase() !== value.toLowerCase(),
    );
    if (await persist(next)) toast.success(t('customLanguageRemoved'));
  };

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div>{t('customLanguages')}</div>
          <p className="text-xs text-muted-foreground">
            {t('customLanguagesDesc')}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-shrink-0 gap-1.5"
          onClick={() => setOpen(true)}
        >
          <Languages className="h-4 w-4" />
          {t('customLanguagesManage', { count: languages.length })}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('customLanguagesDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('customLanguagesDialogDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto">
            <div className="grid grid-cols-[minmax(0,1fr)_140px_auto] gap-2">
              <Input
                value={name}
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('customLanguageNamePlaceholder')}
                aria-label={t('customLanguageName')}
              />
              <Input
                value={code}
                maxLength={35}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleAdd();
                }}
                placeholder={t('customLanguageCodePlaceholder')}
                aria-label={t('customLanguageCode')}
                className="font-mono"
              />
              <Button
                type="button"
                size="sm"
                className="gap-1.5"
                disabled={saving}
                onClick={() => void handleAdd()}
              >
                <Plus className="h-4 w-4" />
                {t('customLanguageAdd')}
              </Button>
            </div>

            {sortedLanguages.length === 0 ? (
              <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">
                {t('customLanguagesEmpty')}
              </div>
            ) : (
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {sortedLanguages.map((language) => (
                  <div
                    key={language.value.toLowerCase()}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {language.name}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {language.value}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      aria-label={t('customLanguageDelete', {
                        name: language.name,
                      })}
                      onClick={() => void handleRemove(language.value)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {t('customLanguagesCompatibilityHint')}
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              {t('customLanguagesDone')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

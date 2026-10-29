/** 一次导入、按站点自动匹配；列表仅展示站点、有效期和清空操作。 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  AlertTriangle,
  Cookie,
  FileUp,
  Globe,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from 'lib/utils';
import type {
  BrowserCookieProfile,
  CookieBatchImportResult,
  CookieProfileView,
} from '../../../types/download';

const BROWSERS = ['firefox', 'chrome', 'edge', 'brave', 'safari'] as const;
type Browser = (typeof BROWSERS)[number];

type CompatLevel = 'ok' | 'warn' | 'blocked';

function platformOf(): NodeJS.Platform | 'unknown' {
  if (typeof window !== 'undefined' && window.ipc?.platform) {
    return window.ipc.platform as NodeJS.Platform;
  }
  return 'unknown';
}

/** 浏览器提取兼容性（按平台）：Windows Chromium 系被 App-Bound Encryption 封死 */
function browserCompat(
  browser: Browser,
  platform: string,
): { level: CompatLevel; noteKey: string } {
  if (browser === 'firefox') {
    return { level: 'ok', noteKey: 'cookie.compatFirefox' };
  }
  if (browser === 'safari') {
    return platform === 'darwin'
      ? { level: 'warn', noteKey: 'cookie.compatSafari' }
      : { level: 'blocked', noteKey: 'cookie.compatSafariNonMac' };
  }
  // chrome / edge / brave（Chromium 系）
  if (platform === 'win32') {
    return browser === 'edge'
      ? { level: 'warn', noteKey: 'cookie.compatEdgeWin' }
      : { level: 'blocked', noteKey: 'cookie.compatChromeWin' };
  }
  if (platform === 'darwin') {
    return { level: 'warn', noteKey: 'cookie.compatChromeMac' };
  }
  return { level: 'ok', noteKey: 'cookie.compatChromiumLinux' };
}

interface CookieProfilesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: CookieProfileView[];
  onChanged: () => void;
  focusProfileId?: string | null;
}

export default function CookieProfilesDialog({
  open,
  onOpenChange,
  profiles,
  onChanged,
  focusProfileId,
}: CookieProfilesDialogProps) {
  const { t } = useTranslation('download');
  const platform = platformOf();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] =
    useState<CookieBatchImportResult | null>(null);
  const [browser, setBrowser] = useState<Browser>(
    platform === 'win32' ? 'firefox' : 'chrome',
  );
  const [browserProfiles, setBrowserProfiles] = useState<
    BrowserCookieProfile[]
  >([]);
  const [browserProfile, setBrowserProfile] = useState('');
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState(false);
  const importedProfiles = profiles.filter(
    (p) => p.configured || p.needsReimport,
  );
  const busy = busyId !== null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProfilesLoading(true);
    setProfilesError(false);
    setBrowserProfiles([]);
    setBrowserProfile('');
    window.ipc
      .invoke('videoDownload:cookieProfiles:browserProfiles', { browser })
      .then((result: BrowserCookieProfile[]) => {
        if (cancelled) return;
        const list = Array.isArray(result) ? result : [];
        setBrowserProfiles(list);
        setBrowserProfile(
          list.find((p) => p.isDefault)?.id || list[0]?.id || '',
        );
      })
      .catch(() => {
        if (!cancelled) setProfilesError(true);
      })
      .finally(() => {
        if (!cancelled) setProfilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [browser, open]);

  useEffect(() => {
    if (!open) {
      setImportError(null);
      setImportResult(null);
    }
  }, [open]);

  const runImport = useCallback(
    async (channel: string, payload: Record<string, unknown>) => {
      setBusyId('import');
      setImportError(null);
      setImportResult(null);
      try {
        const result = await window.ipc.invoke(channel, payload);
        if (result?.cancelled) return;
        setImportResult(result);
        onChanged();
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        let msg = raw;
        if (raw.includes('YTDLP_NOT_INSTALLED')) {
          msg = t('cookie.errNoYtdlp');
        } else if (raw.includes('BROWSER_PERMISSION_DENIED')) {
          msg = t('cookie.errBrowserPermission');
        } else if (raw.includes('BROWSER_NOT_FOUND')) {
          const browser = raw.split('BROWSER_NOT_FOUND::')[1]?.trim() || '';
          msg = t('cookie.errBrowserNotFound', { browser });
        } else if (raw.includes('NO_SUPPORTED_SITE_COOKIES')) {
          msg = t('cookie.errNoSupportedSites');
        } else if (raw.includes('NO_VALID_COOKIES')) {
          msg = t('cookie.errNoValidCookies');
        } else if (raw.includes('BROWSER_COOKIE_DECRYPT_FAILED')) {
          msg = t('cookie.errDecrypt');
        } else if (raw.includes('BROWSER_PROFILE_NOT_FOUND')) {
          msg = t('cookie.errProfileMissing');
        }
        // 内联展示（持久、可读全文），长文案不再被短 toast 截断
        setImportError(msg);
      } finally {
        setBusyId(null);
      }
    },
    [onChanged, t],
  );

  const handleClear = useCallback(
    async (id?: string) => {
      setBusyId(id ?? 'clear-all');
      setImportError(null);
      setImportResult(null);
      try {
        if (id)
          await window.ipc.invoke('videoDownload:cookieProfiles:delete', {
            id,
          });
        else await window.ipc.invoke('videoDownload:cookieProfiles:clearAll');
      } catch {
        setImportError(t('cookie.errClear'));
      } finally {
        setBusyId(null);
        // 删除失败也刷新：例如内容已清除，但元数据写入失败，不能继续展示旧状态。
        onChanged();
      }
    },
    [onChanged, t],
  );

  const expiryText = (profile: CookieProfileView) => {
    if (profile.needsReimport) return t('cookie.reimportRequired');
    if (profile.expired) return t('cookie.expired');
    if (profile.expiresAt)
      return new Date(profile.expiresAt * 1000).toLocaleDateString();
    return t('cookie.expiryUnknown');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cookie className="h-4 w-4" />
            {t('cookie.title')}
          </DialogTitle>
          <DialogDescription>{t('cookie.description')}</DialogDescription>
        </DialogHeader>

        <section aria-label={t('cookie.bulkImport')} className="space-y-2.5">
          <div className="flex gap-2">
            <select
              aria-label={t('cookie.browserLabel')}
              value={browser}
              disabled={busy}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
              onChange={(event) => setBrowser(event.target.value as Browser)}
            >
              {BROWSERS.filter(
                (item) => item !== 'safari' || platform === 'darwin',
              ).map((item) => (
                <option
                  key={item}
                  value={item}
                  disabled={browserCompat(item, platform).level === 'blocked'}
                >
                  {item === 'firefox'
                    ? 'Firefox'
                    : item.charAt(0).toUpperCase() + item.slice(1)}
                </option>
              ))}
            </select>
            {(profilesLoading || browserProfiles.length > 1) && (
              <select
                aria-label={t('cookie.browserProfile')}
                value={browserProfile}
                disabled={busy || profilesLoading}
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm disabled:opacity-60"
                onChange={(event) => setBrowserProfile(event.target.value)}
              >
                {!browserProfiles.length && (
                  <option value="">{t('cookie.loadingProfiles')}</option>
                )}
                {browserProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} ({profile.id})
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                busy ||
                profilesLoading ||
                profilesError ||
                browserCompat(browser, platform).level === 'blocked'
              }
              onClick={() =>
                void runImport(
                  'videoDownload:cookieProfiles:importAllFromBrowser',
                  {
                    browser,
                    ...(browserProfile ? { browserProfile } : {}),
                  },
                )
              }
            >
              {busyId === 'import' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Globe className="mr-1 h-3.5 w-3.5" />
              )}
              {t(busyId === 'import' ? 'cookie.importing' : 'cookie.importAll')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void runImport('videoDownload:cookieProfiles:importAllFile', {})
              }
            >
              <FileUp className="mr-1 h-3.5 w-3.5" />
              {t('cookie.importFile')}
            </Button>
          </div>
          {browserCompat(browser, platform).level !== 'ok' && (
            <p className="text-xs text-muted-foreground">
              {t(browserCompat(browser, platform).noteKey)}
            </p>
          )}
          {profilesError && (
            <p role="alert" className="text-xs text-destructive">
              {t('cookie.errProfileList')}
            </p>
          )}
        </section>

        {importResult && (
          <p role="status" className="text-xs text-muted-foreground">
            {t('cookie.batchSuccess', { count: importResult.profiles.length })}
          </p>
        )}
        {importError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{importError}</span>
            <button
              type="button"
              onClick={() => setImportError(null)}
              aria-label={t('cookie.cancel')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <section className="flex min-h-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {t('cookie.importedSites', { count: importedProfiles.length })}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              disabled={busy || !importedProfiles.length}
              onClick={() => void handleClear()}
            >
              {busyId === 'clear-all' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3.5 w-3.5" />
              )}
              {t('cookie.clearAll')}
            </Button>
          </div>
          {importedProfiles.length ? (
            <div className="min-h-0 overflow-y-auto rounded-md border">
              <table
                aria-label={t('cookie.entry')}
                className="w-full table-fixed text-sm"
              >
                <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-normal">
                      {t('cookie.site')}
                    </th>
                    <th
                      scope="col"
                      className="w-36 px-3 py-2 text-left font-normal"
                    >
                      {t('cookie.expiry')}
                    </th>
                    <th scope="col" className="w-16 px-2 py-2">
                      <span className="sr-only">{t('cookie.clear')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {importedProfiles.map((profile) => {
                    const name = profile.isNameLiteral
                      ? profile.name
                      : t(profile.name);
                    return (
                      <tr
                        key={profile.id}
                        className={cn(
                          focusProfileId === profile.id && 'bg-accent/50',
                        )}
                      >
                        <td className="truncate px-3 py-1" title={name}>
                          {name}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-1 text-xs tabular-nums',
                            profile.expired || profile.needsReimport
                              ? 'text-destructive'
                              : 'text-muted-foreground',
                          )}
                        >
                          {expiryText(profile)}
                        </td>
                        <td className="px-1 py-1 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                            aria-label={t('cookie.clearSite', { name })}
                            disabled={busy}
                            onClick={() => void handleClear(profile.id)}
                          >
                            {busyId === profile.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              t('cookie.clear')
                            )}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('cookie.empty')}
            </p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

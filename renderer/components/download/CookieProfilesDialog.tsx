/**
 * 默认批量识别站点；单站点导入和自定义域名保留在手动管理入口。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ClipboardPaste,
  Cookie,
  FileUp,
  Globe,
  Loader2,
  Plus,
  ShieldAlert,
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
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from 'lib/utils';
import {
  COOKIE_SITE_PRESETS,
  type BrowserCookieProfile,
  type CookieBatchImportResult,
  type CookieProfileView,
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

interface CustomDef {
  name: string;
  matchDomains: string[];
  cookieDomains: string[];
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
  const [pasteFor, setPasteFor] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customDomain, setCustomDomain] = useState('');
  // 导入失败信息内联展示（文案偏长、含操作指引，比短 toast 更完整可读）
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
  const configuredProfiles = profiles.filter(
    (p) => p.configured || p.needsReimport,
  );
  const missingProfiles = profiles.filter(
    (p) => !p.configured && !p.needsReimport,
  );

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
      setPasteFor(null);
      setPasteText('');
      setShowCustom(false);
      setCustomName('');
      setCustomDomain('');
      setImportError(null);
      setImportResult(null);
    }
  }, [open]);

  const reload = useCallback(() => onChanged(), [onChanged]);

  const runImport = useCallback(
    async (channel: string, payload: Record<string, unknown>, id: string) => {
      setBusyId(id);
      setImportError(null);
      setImportResult(null);
      try {
        const res = await window?.ipc?.invoke(channel, payload);
        if (res?.cancelled) return;
        if (Array.isArray(res?.profiles)) {
          setImportResult(res);
        } else {
          toast.success(
            t('cookie.importSuccess', { count: res?.cookieCount ?? 0 }),
          );
        }
        setPasteFor(null);
        setPasteText('');
        setShowCustom(false);
        setCustomName('');
        setCustomDomain('');
        reload();
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
    [reload, t],
  );

  const customDefFor = useCallback(
    (id: string): CustomDef | undefined => {
      const profile = profiles.find((p) => p.id === id);
      if (profile && profile.kind === 'custom') {
        return {
          name: profile.name,
          matchDomains: profile.matchDomains,
          cookieDomains: profile.cookieDomains,
        };
      }
      return undefined;
    },
    [profiles],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await window?.ipc?.invoke('videoDownload:cookieProfiles:delete', {
          id,
        });
        reload();
      } catch {
        setImportError(t('cookie.errDelete'));
      } finally {
        setBusyId(null);
      }
    },
    [reload, t],
  );

  const addCustomAndImport = useCallback(
    (kind: 'file' | 'paste' | 'browser') => {
      const name = customName.trim();
      const domain = customDomain.trim().toLowerCase();
      if (!domain) {
        toast.error(t('cookie.errNoDomain'));
        return;
      }
      const id = `custom-${crypto.randomUUID()}`;
      const customDef: CustomDef = {
        name: name || domain,
        matchDomains: [domain],
        cookieDomains: [domain],
      };
      if (kind === 'file') {
        void runImport(
          'videoDownload:cookieProfiles:importFile',
          { id, customDef },
          'custom-draft',
        );
      } else if (kind === 'browser') {
        void runImport(
          'videoDownload:cookieProfiles:importFromBrowser',
          {
            id,
            browser,
            browserProfile: browserProfile || undefined,
            customDef,
          },
          'custom-draft',
        );
      } else if (kind === 'paste') {
        if (!pasteText.trim()) {
          toast.error(t('cookie.errNoPaste'));
          return;
        }
        void runImport(
          'videoDownload:cookieProfiles:importPaste',
          { id, raw: pasteText, customDef },
          'custom-draft',
        );
      }
    },
    [
      customName,
      customDomain,
      pasteText,
      runImport,
      t,
      browser,
      browserProfile,
    ],
  );

  const renderImportButtons = (id: string, isDraft: boolean) => {
    const busy = busyId !== null;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={
            busy ||
            profilesLoading ||
            profilesError ||
            browserCompat(browser, platform).level === 'blocked'
          }
          onClick={() => {
            if (isDraft) addCustomAndImport('browser');
            else
              void runImport(
                'videoDownload:cookieProfiles:importFromBrowser',
                {
                  id,
                  browser,
                  browserProfile: browserProfile || undefined,
                  customDef: customDefFor(id),
                },
                id,
              );
          }}
        >
          <Globe className="mr-1 h-3.5 w-3.5" />
          {t('cookie.importSelectedBrowser', {
            browser: browser.charAt(0).toUpperCase() + browser.slice(1),
          })}
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => {
            if (isDraft) {
              addCustomAndImport('file');
            } else {
              void runImport(
                'videoDownload:cookieProfiles:importFile',
                { id, customDef: customDefFor(id) },
                id,
              );
            }
          }}
        >
          <FileUp className="mr-1 h-3.5 w-3.5" />
          {t('cookie.importFile')}
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => {
            setPasteText('');
            setPasteFor(pasteFor === id ? null : id);
          }}
        >
          <ClipboardPaste className="mr-1 h-3.5 w-3.5" />
          {t('cookie.importPaste')}
        </Button>
      </div>
    );
  };

  const renderPasteBox = (id: string, isDraft: boolean) => {
    if (pasteFor !== id) return null;
    return (
      <div className="mt-2 space-y-1.5">
        <Textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={t('cookie.pastePlaceholder')}
          className="h-16 text-xs"
        />
        <div className="flex justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => {
              setPasteFor(null);
              setPasteText('');
            }}
          >
            {t('cookie.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={busyId !== null || !pasteText.trim()}
            onClick={() => {
              if (isDraft) {
                addCustomAndImport('paste');
              } else {
                void runImport(
                  'videoDownload:cookieProfiles:importPaste',
                  { id, raw: pasteText, customDef: customDefFor(id) },
                  id,
                );
              }
            }}
          >
            {t('cookie.confirmImport')}
          </Button>
        </div>
      </div>
    );
  };

  const renderStatus = (profile: CookieProfileView) => {
    if (profile.needsReimport) {
      return (
        <span className="flex items-center gap-1 text-destructive">
          <AlertTriangle className="h-3 w-3" />
          {t('cookie.needsReimport')}
        </span>
      );
    }
    if (!profile.configured) {
      return (
        <span className="text-muted-foreground">
          {t('cookie.notConfigured')}
        </span>
      );
    }
    const parts: React.ReactNode[] = [];
    parts.push(
      <span key="src">
        {profile.browser
          ? `${profile.browser}${profile.browserProfile ? ` · ${profile.browserProfile}` : ''}`
          : t(`cookie.source_${profile.source}`)}{' '}
        · {t('cookie.cookieCount', { count: profile.cookieCount ?? 0 })}
      </span>,
    );
    if (profile.importedAt) {
      parts.push(
        <span key="imported" className="text-muted-foreground">
          {t('cookie.importedAt', {
            date: new Date(profile.importedAt).toLocaleString(),
          })}
        </span>,
      );
    }
    if (profile.expired) {
      parts.push(
        <Badge key="exp" variant="destructive" className="h-4 px-1 text-[10px]">
          {t('cookie.expired')}
        </Badge>,
      );
    } else if (profile.expiresAt) {
      parts.push(
        <span key="expat" className="text-muted-foreground">
          {t('cookie.expiresAt', {
            date: new Date(profile.expiresAt * 1000).toLocaleDateString(),
          })}
        </span>,
      );
    } else {
      parts.push(
        <span key="sess" className="text-muted-foreground">
          {t('cookie.noExpiry')}
        </span>,
      );
    }
    return <span className="flex flex-wrap items-center gap-1.5">{parts}</span>;
  };

  const renderProfile = (profile: CookieProfileView) => (
    <div
      key={profile.id}
      className={cn(
        'rounded-md border p-3',
        focusProfileId === profile.id && 'ring-2 ring-primary',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {profile.isNameLiteral ? profile.name : t(profile.name)}
            {profile.configured && (
              <Badge variant="secondary" className="text-[10px]">
                {t('cookie.imported')}
              </Badge>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {profile.matchDomains.join(', ')}
          </div>
        </div>
        {(profile.configured ||
          profile.needsReimport ||
          profile.kind === 'custom') && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 flex-shrink-0"
            disabled={busyId !== null}
            onClick={() => handleDelete(profile.id)}
            title={t('cookie.delete')}
            aria-label={t('cookie.delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="mt-2 text-xs">{renderStatus(profile)}</div>
      <details
        className="mt-2"
        open={focusProfileId === profile.id || undefined}
      >
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t('cookie.manageSite')}
        </summary>
        {profile.hasRiskNote && (
          <p className="my-2 flex items-center gap-1 text-[11px] text-warning">
            <ShieldAlert className="h-3 w-3" />
            {t('cookie.riskNote')}
          </p>
        )}
        <div className="mt-2">{renderImportButtons(profile.id, false)}</div>
        {renderPasteBox(profile.id, false)}
      </details>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cookie className="h-4 w-4" />
            {t('cookie.title')}
          </DialogTitle>
          <DialogDescription>{t('cookie.description')}</DialogDescription>
        </DialogHeader>

        <section
          aria-label={t('cookie.bulkImport')}
          className="space-y-3 rounded-lg border bg-muted/30 p-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">
              <span>{t('cookie.browserLabel')}</span>
              <select
                aria-label={t('cookie.browserLabel')}
                value={browser}
                disabled={busyId !== null}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                onChange={(e) => setBrowser(e.target.value as Browser)}
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
            </label>
            <label className="space-y-1 text-xs">
              <span>{t('cookie.browserProfile')}</span>
              <select
                aria-label={t('cookie.browserProfile')}
                value={browserProfile}
                disabled={
                  busyId !== null || profilesLoading || !browserProfiles.length
                }
                className="h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-60"
                onChange={(e) => setBrowserProfile(e.target.value)}
              >
                {!browserProfiles.length && (
                  <option value="">
                    {t(
                      profilesLoading
                        ? 'cookie.loadingProfiles'
                        : 'cookie.autoProfile',
                    )}
                  </option>
                )}
                {browserProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} ({profile.id})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(browserCompat(browser, platform).noteKey)}
          </p>
          {profilesError && (
            <p role="alert" className="text-xs text-destructive">
              {t('cookie.errProfileList')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                busyId !== null ||
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
                  'bulk',
                )
              }
            >
              {busyId === 'bulk' ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Globe className="mr-1.5 h-4 w-4" />
              )}
              {t(busyId === 'bulk' ? 'cookie.importing' : 'cookie.importAll')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busyId !== null}
              onClick={() =>
                void runImport(
                  'videoDownload:cookieProfiles:importAllFile',
                  {},
                  'bulk',
                )
              }
            >
              <FileUp className="mr-1.5 h-4 w-4" />
              {t('cookie.importFile')}
            </Button>
          </div>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {t('cookie.supportedSites')}
            </summary>
            <p className="mt-1 leading-relaxed">
              {COOKIE_SITE_PRESETS.map((preset) => t(preset.nameKey)).join(
                ' · ',
              )}
            </p>
            <p className="mt-1">{t('cookie.supportedSitesHint')}</p>
          </details>
        </section>

        {importResult && (
          <div
            role="status"
            className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs"
          >
            <p className="font-medium">
              {t('cookie.batchSuccess', {
                count: importResult.profiles.length,
                cookies: importResult.cookieCount,
              })}
            </p>
            <p>
              {importResult.profiles
                .map((profile) =>
                  profile.isNameLiteral ? profile.name : t(profile.name),
                )
                .join(' · ')}
            </p>
            <p className="text-muted-foreground">
              {t('cookie.batchResultHint', {
                count: importResult.ignoredCookieCount,
              })}
            </p>
          </div>
        )}

        {importError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span className="min-w-0 flex-1 leading-relaxed">
              {importError}
            </span>
            <button
              type="button"
              onClick={() => setImportError(null)}
              className="flex-shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
              aria-label={t('cookie.cancel')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="max-h-[60vh] space-y-2.5 overflow-y-auto pr-1">
          <div className="text-xs font-medium">
            {t('cookie.importedSites', { count: configuredProfiles.length })}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('cookie.validityHint')}
          </p>
          {configuredProfiles.length ? (
            configuredProfiles.map(renderProfile)
          ) : (
            <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              {t('cookie.empty')}
            </p>
          )}
          <details
            open={
              missingProfiles.some((p) => p.id === focusProfileId) || undefined
            }
          >
            <summary className="cursor-pointer py-2 text-xs text-muted-foreground">
              {t('cookie.manualManagement')}
            </summary>
            <div className="space-y-2.5">
              {missingProfiles.map(renderProfile)}
              {/* 自定义域名档案 */}
              {showCustom ? (
                <div className="rounded-md border border-dashed p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      value={customName}
                      onChange={(e) => setCustomName(e.target.value)}
                      placeholder={t('cookie.customNamePlaceholder')}
                      className="h-8 text-xs"
                    />
                    <Input
                      value={customDomain}
                      onChange={(e) => setCustomDomain(e.target.value)}
                      placeholder={t('cookie.customDomainPlaceholder')}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="mt-2">
                    {renderImportButtons('custom-draft', true)}
                  </div>
                  {renderPasteBox('custom-draft', true)}
                  <div className="mt-2 flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setShowCustom(false)}
                    >
                      {t('cookie.cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-dashed text-xs"
                  disabled={busyId !== null}
                  onClick={() => setShowCustom(true)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t('cookie.addCustom')}
                </Button>
              )}
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}

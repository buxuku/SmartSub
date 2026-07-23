/**
 * 站点 Cookie 档案管理对话框：预设（bilibili/youtube）+ 自定义域名档案。
 * 三种导入（浏览器提取/cookies.txt 文件/粘贴原始串），按站点隔离存储，
 * 展示来源/导入时间/过期状态，支持删除。浏览器提取按平台标注兼容性。
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from 'lib/utils';
import type { CookieProfileView } from '../../../types/download';

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

  useEffect(() => {
    if (!open) {
      setPasteFor(null);
      setPasteText('');
      setShowCustom(false);
      setCustomName('');
      setCustomDomain('');
      setImportError(null);
    }
  }, [open]);

  const reload = useCallback(() => onChanged(), [onChanged]);

  const runImport = useCallback(
    async (channel: string, payload: Record<string, unknown>, id: string) => {
      setBusyId(id);
      setImportError(null);
      try {
        const res = await window?.ipc?.invoke(channel, payload);
        if (res?.cancelled) return;
        toast.success(
          t('cookie.importSuccess', {
            count: res?.cookieCount ?? 0,
          }),
        );
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
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const addCustomAndImport = useCallback(
    (kind: 'file' | 'paste' | 'browser', browser?: Browser) => {
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
      } else if (kind === 'browser' && browser) {
        void runImport(
          'videoDownload:cookieProfiles:importFromBrowser',
          { id, browser, customDef },
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
    [customName, customDomain, pasteText, runImport, t],
  );

  const renderImportButtons = (
    id: string,
    isDraft: boolean,
    draftBrowserImport?: (browser: Browser) => void,
  ) => {
    const busy = busyId === id || (isDraft && busyId === 'custom-draft');
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Globe className="mr-1 h-3.5 w-3.5" />
              )}
              {t('cookie.importBrowser')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {BROWSERS.map((browser) => {
              const compat = browserCompat(browser, platform);
              if (compat.level === 'blocked' && browser === 'safari') {
                return null;
              }
              return (
                <DropdownMenuItem
                  key={browser}
                  disabled={compat.level === 'blocked'}
                  // 显式 hover 高亮：嵌在模态 Dialog 内时 Radix 的 pointermove→focus
                  // 高亮驱动失灵，直接用 CSS hover 兜底（不影响键盘 focus 高亮）
                  className="cursor-pointer hover:bg-accent hover:text-accent-foreground"
                  onSelect={() => {
                    if (isDraft && draftBrowserImport) {
                      draftBrowserImport(browser);
                    } else {
                      void runImport(
                        'videoDownload:cookieProfiles:importFromBrowser',
                        { id, browser, customDef: customDefFor(id) },
                        id,
                      );
                    }
                  }}
                >
                  <span className="capitalize">{browser}</span>
                  <span
                    className={cn(
                      'ml-2 text-[11px]',
                      compat.level === 'blocked'
                        ? 'text-destructive'
                        : compat.level === 'warn'
                          ? 'text-warning'
                          : 'text-muted-foreground',
                    )}
                  >
                    {t(compat.noteKey)}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

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
            disabled={!pasteText.trim()}
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
        {t(`cookie.source_${profile.source}`)} ·{' '}
        {t('cookie.cookieCount', { count: profile.cookieCount ?? 0 })}
      </span>,
    );
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cookie className="h-4 w-4" />
            {t('cookie.title')}
          </DialogTitle>
          <DialogDescription>{t('cookie.description')}</DialogDescription>
        </DialogHeader>

        {importError && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
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
          {profiles.map((profile) => (
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
                    {profile.hasRiskNote && (
                      <span
                        className="flex items-center gap-0.5 text-[11px] text-warning"
                        title={t('cookie.riskNote')}
                      >
                        <ShieldAlert className="h-3 w-3" />
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {profile.matchDomains.join(', ')}
                  </div>
                </div>
                {(profile.configured || profile.kind === 'custom') && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 flex-shrink-0"
                    disabled={busyId === profile.id}
                    onClick={() => handleDelete(profile.id)}
                    title={t('cookie.delete')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              {profile.hasRiskNote && (
                <div className="mt-1.5 rounded bg-warning/10 px-2 py-1 text-[11px] text-warning">
                  {t('cookie.riskNote')}
                </div>
              )}

              <div className="mt-2 text-xs">{renderStatus(profile)}</div>

              <div className="mt-2">
                {renderImportButtons(profile.id, false)}
              </div>
              {renderPasteBox(profile.id, false)}
            </div>
          ))}

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
                {renderImportButtons('custom-draft', true, (browser) =>
                  addCustomAndImport('browser', browser),
                )}
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
              onClick={() => setShowCustom(true)}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t('cookie.addCustom')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Copy, ExternalLink, Loader2, Plug, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import IconChip from '../IconChip';
import type { McpConnectionConfig } from '../../../types/mcpConfig';

export default function McpConnectionCard() {
  const { t } = useTranslation('settings');
  const [config, setConfig] = useState<McpConnectionConfig>();
  const [client, setClient] = useState('cursor');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    void window.ipc.invoke('mcp:get-config').then(
      (value: McpConnectionConfig) => {
        if (!disposed) {
          setConfig(value);
          setLoading(false);
        }
      },
      () => {
        if (!disposed) {
          setError('mcp.loadFailed');
          setLoading(false);
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [retry]);
  const copy = async () => {
    if (!config || busy) return;
    setBusy(true);
    setError('');
    try {
      await navigator.clipboard.writeText(
        client === 'codex' ? config.toml : config.json,
      );
      toast.success(t('mcp.copied'));
    } catch {
      setError('mcp.copyFailed');
    } finally {
      setBusy(false);
    }
  };
  const installCursor = async () => {
    if (!config || busy) return;
    setBusy(true);
    setError('');
    try {
      await window.ipc.invoke('mcp:install-cursor');
      toast.success(t('mcp.cursorOpened'));
    } catch {
      setError('mcp.cursorFailed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="mcp-connection-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconChip icon={Plug} />
          {t('mcp.title')}
        </CardTitle>
        <p className="pt-1 text-sm text-muted-foreground">
          {t('mcp.description')}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs
          value={client}
          onValueChange={(value) => {
            setClient(value);
            setError('');
          }}
        >
          <TabsList aria-label={t('mcp.client')}>
            <TabsTrigger value="cursor" disabled={busy}>
              Cursor
            </TabsTrigger>
            <TabsTrigger value="codex" disabled={busy}>
              Codex
            </TabsTrigger>
            <TabsTrigger value="other" disabled={busy}>
              {t('mcp.other')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(`mcp.${client}Hint`)}
        </p>
        {loading && (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('mcp.loading')}
          </p>
        )}
        {config && !loading && (
          <>
            <div className="flex flex-wrap gap-2">
              {client === 'cursor' && (
                <Button disabled={busy} onClick={() => void installCursor()}>
                  <ExternalLink className="h-4 w-4" />
                  {t('mcp.installCursor')}
                </Button>
              )}
              <Button
                variant={client === 'cursor' ? 'outline' : 'default'}
                disabled={busy}
                onClick={() => void copy()}
              >
                <Copy className="h-4 w-4" />
                {t('mcp.copyConfig')}
              </Button>
            </div>
            <details className="rounded-lg border bg-muted/20">
              <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
                {t('mcp.preview')} · {client === 'codex' ? 'TOML' : 'JSON'}
              </summary>
              <pre
                tabIndex={0}
                aria-label={t('mcp.preview')}
                className="max-h-64 overflow-auto border-t p-3 text-xs leading-5"
              >
                <code>{client === 'codex' ? config.toml : config.json}</code>
              </pre>
            </details>
          </>
        )}
        {error && (
          <div
            role="alert"
            className="space-y-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            <p>{t(error)}</p>
            {!config && (
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => setRetry((value) => value + 1)}
              >
                <RefreshCw className="h-4 w-4" />
                {t('mcp.retry')}
              </Button>
            )}
          </div>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('mcp.locationHint')}
        </p>
      </CardContent>
    </Card>
  );
}

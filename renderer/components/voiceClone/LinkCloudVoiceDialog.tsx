import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, CloudDownload, Loader2, RefreshCw } from 'lucide-react';
import { cn } from 'lib/utils';
import {
  TTS_ELEVENLABS,
  TTS_VOLCENGINE,
  getTtsProviderType,
  isTtsProviderConfigured,
  type TtsProvider,
} from '../../../types/ttsProvider';
import type { ClonedVoiceView } from '../../../types/voiceClone';

interface CloudVoiceItem {
  id: string;
  name: string;
  linked: boolean;
}

/**
 * 「从平台取回」对话框：把平台上已存在的云端克隆音色接回本地列表。
 * - ElevenLabs：拉取账号 IVC 清单（category==='cloned'）点选接回；
 * - 火山：无列表接口，输入 S_ 槽位 ID，经状态接口校验后接回。
 */
export default function LinkCloudVoiceDialog({
  open,
  onOpenChange,
  onListCloud,
  onLink,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onListCloud: (providerId: string) => Promise<any>;
  onLink: (args: {
    engine: 'volcengine' | 'elevenlabs';
    providerId: string;
    speakerId: string;
    name?: string;
    language: 'zh' | 'en';
  }) => Promise<any>;
  onLinked?: (voice: ClonedVoiceView) => void;
}) {
  const { t } = useTranslation('voiceClone');
  const [engine, setEngine] = useState<'elevenlabs' | 'volcengine'>(
    'elevenlabs',
  );
  const [elevenProvider, setElevenProvider] = useState<TtsProvider | null>(
    null,
  );
  const [volcProvider, setVolcProvider] = useState<TtsProvider | null>(null);
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // EL 分支
  const [cloudVoices, setCloudVoices] = useState<CloudVoiceItem[] | null>(null);
  const [listing, setListing] = useState(false);

  // 火山分支
  const [speakerId, setSpeakerId] = useState('');
  const [volcName, setVolcName] = useState('');

  useEffect(() => {
    if (!open) {
      setEngine('elevenlabs');
      setCloudVoices(null);
      setListing(false);
      setSpeakerId('');
      setVolcName('');
      setLanguage('zh');
      setLinkingId(null);
      setError(null);
      return;
    }
    window.ipc
      .invoke('getTtsProviders')
      .then((providers: TtsProvider[]) => {
        const configured = (providers ?? []).filter((x) =>
          isTtsProviderConfigured(x, getTtsProviderType(x.type)),
        );
        const el = configured.find((x) => x.type === TTS_ELEVENLABS) ?? null;
        const volc = configured.find((x) => x.type === TTS_VOLCENGINE) ?? null;
        setElevenProvider(el);
        setVolcProvider(volc);
        if (!el && volc) setEngine('volcengine');
      })
      .catch(() => {
        setElevenProvider(null);
        setVolcProvider(null);
      });
  }, [open]);

  const loadCloudList = useCallback(async () => {
    if (!elevenProvider || listing) return;
    setListing(true);
    setError(null);
    try {
      const r = await onListCloud(String(elevenProvider.id));
      if (r?.success) {
        setCloudVoices((r.data as CloudVoiceItem[]) ?? []);
      } else {
        setError(r?.error || 'list failed');
      }
    } finally {
      setListing(false);
    }
  }, [elevenProvider, listing, onListCloud]);

  // EL 分支打开即拉清单。
  useEffect(() => {
    if (open && engine === 'elevenlabs' && elevenProvider && !cloudVoices) {
      loadCloudList();
    }
  }, [open, engine, elevenProvider, cloudVoices, loadCloudList]);

  const linkEleven = useCallback(
    async (v: CloudVoiceItem) => {
      if (!elevenProvider || linkingId) return;
      setLinkingId(v.id);
      setError(null);
      try {
        const r = await onLink({
          engine: 'elevenlabs',
          providerId: String(elevenProvider.id),
          speakerId: v.id,
          name: v.name,
          language,
        });
        if (r?.success) {
          onLinked?.(r.data as ClonedVoiceView);
          onOpenChange(false);
        } else {
          setError(r?.error || 'link failed');
        }
      } finally {
        setLinkingId(null);
      }
    },
    [elevenProvider, linkingId, language, onLink, onLinked, onOpenChange],
  );

  const linkVolc = useCallback(async () => {
    if (!volcProvider || linkingId) return;
    setLinkingId('volc');
    setError(null);
    try {
      const r = await onLink({
        engine: 'volcengine',
        providerId: String(volcProvider.id),
        speakerId: speakerId.trim(),
        name: volcName.trim() || undefined,
        language,
      });
      if (r?.success) {
        onLinked?.(r.data as ClonedVoiceView);
        onOpenChange(false);
      } else {
        setError(r?.error || 'link failed');
      }
    } finally {
      setLinkingId(null);
    }
  }, [
    volcProvider,
    linkingId,
    speakerId,
    volcName,
    language,
    onLink,
    onLinked,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudDownload className="h-4 w-4" />
            {t('linkTitle')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('linkIntro')}</p>

          {/* 引擎切换 */}
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                {
                  id: 'elevenlabs' as const,
                  enabled: !!elevenProvider,
                  title: t('engineElevenlabs'),
                  hint: elevenProvider ? null : t('engineElevenNeedProvider'),
                },
                {
                  id: 'volcengine' as const,
                  enabled: !!volcProvider,
                  title: t('engineVolcengine'),
                  hint: volcProvider ? null : t('engineVolcNeedProvider'),
                },
              ] satisfies Array<{
                id: 'elevenlabs' | 'volcengine';
                enabled: boolean;
                title: string;
                hint: string | null;
              }>
            ).map((card) => (
              <button
                key={card.id}
                type="button"
                disabled={!card.enabled}
                onClick={() => {
                  setEngine(card.id);
                  setError(null);
                }}
                className={cn(
                  'rounded-lg border p-2.5 text-left text-sm transition-colors',
                  engine === card.id
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'hover:bg-muted/40',
                  !card.enabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <p className="font-medium">{card.title}</p>
                {card.hint && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {card.hint}
                  </p>
                )}
              </button>
            ))}
          </div>

          {/* 语言（试听样本文案用） */}
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">{t('language')}</label>
            <Select
              value={language}
              onValueChange={(v) => setLanguage(v as 'zh' | 'en')}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh">{t('langZh')}</SelectItem>
                <SelectItem value="en">{t('langEn')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {engine === 'elevenlabs' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('linkCloudList')}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={listing || !elevenProvider}
                  onClick={loadCloudList}
                >
                  {listing ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t('refreshStatus')}
                </Button>
              </div>
              <div className="max-h-52 overflow-y-auto rounded-md border">
                {listing && !cloudVoices && (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('linkLoading')}
                  </div>
                )}
                {cloudVoices && cloudVoices.length === 0 && (
                  <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                    {t('linkEmpty')}
                  </p>
                )}
                {(cloudVoices ?? []).map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{v.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {v.id}
                      </p>
                    </div>
                    {v.linked ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('linkAlready')}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!linkingId}
                        onClick={() => linkEleven(v)}
                      >
                        {linkingId === v.id ? (
                          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CloudDownload className="mr-1 h-3.5 w-3.5" />
                        )}
                        {t('linkAction')}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {engine === 'volcengine' && (
            <div className="space-y-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('speakerIdLabel')}
                  <span className="text-destructive"> *</span>
                </label>
                <Input
                  value={speakerId}
                  onChange={(e) => setSpeakerId(e.target.value)}
                  placeholder={t('speakerIdPlaceholder')}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  {t('linkVolcHint')}
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('nameLabel')}</label>
                <Input
                  value={volcName}
                  onChange={(e) => setVolcName(e.target.value)}
                  placeholder={t('namePlaceholder')}
                />
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!speakerId.trim().startsWith('S_') || !!linkingId}
                  onClick={linkVolc}
                >
                  {linkingId === 'volc' ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CloudDownload className="mr-1 h-3.5 w-3.5" />
                  )}
                  {t('linkAction')}
                </Button>
              </div>
            </div>
          )}

          {error && (
            <p className="flex items-start gap-1.5 break-all rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

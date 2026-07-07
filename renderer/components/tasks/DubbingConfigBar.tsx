import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Download, Loader2, Play } from 'lucide-react';
import {
  getTtsVoices,
  getTtsDefaultVoice,
  groupTtsVoices,
  formatTtsVoiceLabel,
} from 'lib/ttsVoices';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import {
  isTtsProviderConfigured,
  type TtsProvider,
} from '../../../types/ttsProvider';

type TtsModelId = 'kokoro-multi-lang-v1_1' | 'vits-zh-aishell3';

function ConfigItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {label}
      </span>
      {children}
    </div>
  );
}

const triggerClass = 'h-8 w-auto min-w-[120px] max-w-[200px] text-xs gap-1';

interface DubbingConfigBarProps {
  form: any;
  formData: any;
  systemInfo: any;
  files?: any[];
}

const DubbingConfigBar: React.FC<DubbingConfigBarProps> = ({
  form,
  formData,
  systemInfo,
  files = [],
}) => {
  const { t } = useTranslation('tasks');
  const router = useRouter();
  const { locale } = router.query;
  const setValue = (name: string, value: unknown) => form.setValue(name, value);

  const installedIds = (systemInfo?.ttsModelsInstalled || []) as TtsModelId[];
  const hasLocal = installedIds.length > 0;
  const [cloudProviders, setCloudProviders] = useState<TtsProvider[]>([]);

  const ttsSource = formData?.ttsSource === 'cloud' ? 'cloud' : 'local';
  const configuredCloud = cloudProviders.filter((p) =>
    isTtsProviderConfigured(p),
  );
  const hasCloud = configuredCloud.length > 0;
  const ready = hasLocal || hasCloud;

  const [auditioning, setAuditioning] = useState(false);
  const [charCount, setCharCount] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    (async () => {
      const raw = (await window?.ipc?.invoke('getTtsProviders')) || [];
      if (Array.isArray(raw)) setCloudProviders(raw);
    })();
  }, []);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (ttsSource !== 'local' || !hasLocal || !formData?.ttsModelId) return;
    const voices = getTtsVoices(formData.ttsModelId);
    const sid = Number(formData.ttsVoiceSid);
    if (!voices.some((v) => v.sid === sid)) {
      setValue('ttsVoiceSid', getTtsDefaultVoice(formData.ttsModelId));
    }
  }, [
    formData?.ttsModelId,
    formData?.ttsVoiceSid,
    hasLocal,
    ttsSource,
    setValue,
  ]);

  useEffect(() => {
    if (ttsSource !== 'cloud' || !hasCloud) return;
    const current = formData?.ttsProviderId as string | undefined;
    if (!current || !configuredCloud.some((p) => p.id === current)) {
      setValue('ttsProviderId', configuredCloud[0]?.id || '');
    }
  }, [ttsSource, hasCloud, configuredCloud, formData?.ttsProviderId, setValue]);

  useEffect(() => {
    if (ttsSource !== 'cloud' || !files.length) {
      setCharCount(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const count = (await window?.ipc?.invoke('estimateDubbingCharCount', {
          files,
          formData,
        })) as number;
        if (!cancelled) setCharCount(typeof count === 'number' ? count : null);
      } catch {
        if (!cancelled) setCharCount(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ttsSource, files, formData]);

  const handleAudition = useCallback(async () => {
    const model = formData?.ttsModelId as TtsModelId;
    const sid = Number(formData?.ttsVoiceSid ?? 0);
    if (!model || !installedIds.includes(model)) return;
    setAuditioning(true);
    try {
      const r = await window?.ipc?.invoke('auditionTtsVoice', { model, sid });
      if (!r?.success || !r.file) {
        toast.error(r?.error || t('dubbing.auditionFailed'));
        return;
      }
      audioRef.current?.pause();
      const audio = new Audio(`media://${encodeURI(r.file)}`);
      audioRef.current = audio;
      await audio.play();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAuditioning(false);
    }
  }, [formData?.ttsModelId, formData?.ttsVoiceSid, installedIds, t]);

  if (!ready) {
    return (
      <ConfigItem label={t('dubbing.ttsSource')}>
        <div className="flex gap-2">
          {!hasLocal && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
            >
              <Link href={`/${locale}/engines`}>
                <Download className="h-4 w-4" />
                {t('goDownloadTtsModel')}
              </Link>
            </Button>
          )}
          {!hasCloud && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
            >
              <Link href={`/${locale}/engines`}>
                {t('goConfigureTtsProvider')}
              </Link>
            </Button>
          )}
        </div>
      </ConfigItem>
    );
  }

  const modelId = (formData?.ttsModelId || installedIds[0]) as TtsModelId;
  const voices = getTtsVoices(modelId);
  const voiceGroups = groupTtsVoices(modelId, voices);
  const voiceTrait = (key: string) => t(`dubbing.${key}`);
  const selectedSid = Number(
    formData?.ttsVoiceSid ?? getTtsDefaultVoice(modelId),
  );
  const selectedVoice = voices.find((v) => v.sid === selectedSid);

  return (
    <>
      <ConfigItem label={t('dubbing.ttsSource')}>
        <Select
          value={ttsSource}
          onValueChange={(v) => setValue('ttsSource', v)}
        >
          <SelectTrigger className={triggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {hasLocal && (
              <SelectItem value="local">{t('dubbing.source.local')}</SelectItem>
            )}
            {hasCloud && (
              <SelectItem value="cloud">{t('dubbing.source.cloud')}</SelectItem>
            )}
          </SelectContent>
        </Select>
      </ConfigItem>

      {ttsSource === 'local' && hasLocal && (
        <>
          <ConfigItem label={t('dubbing.ttsModel')}>
            <Select
              value={modelId}
              onValueChange={(v) => {
                setValue('ttsModelId', v);
                setValue('ttsVoiceSid', getTtsDefaultVoice(v));
              }}
            >
              <SelectTrigger className={triggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {installedIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {t(`dubbing.model.${id}`, { defaultValue: id })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ConfigItem>

          <ConfigItem label={t('dubbing.voice')}>
            <div className="flex items-center gap-1">
              <Select
                value={String(selectedSid)}
                onValueChange={(v) => setValue('ttsVoiceSid', Number(v))}
              >
                <SelectTrigger className="h-8 w-auto min-w-[180px] max-w-[280px] text-xs">
                  <SelectValue>
                    {selectedVoice
                      ? formatTtsVoiceLabel(selectedVoice, modelId, voiceTrait)
                      : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {voiceGroups.map((group) => (
                    <SelectGroup key={group.key}>
                      <SelectLabel>
                        {t(`dubbing.${group.labelKey}`)}
                      </SelectLabel>
                      {group.voices.map((v) => (
                        <SelectItem key={v.sid} value={String(v.sid)}>
                          {formatTtsVoiceLabel(v, modelId, voiceTrait)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-8 w-8 flex-shrink-0"
                disabled={auditioning}
                aria-label={t('dubbing.audition')}
                onClick={handleAudition}
              >
                {auditioning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </ConfigItem>
        </>
      )}

      {ttsSource === 'cloud' && hasCloud && (
        <ConfigItem label={t('dubbing.cloudProvider')}>
          <Select
            value={formData?.ttsProviderId || configuredCloud[0]?.id}
            onValueChange={(v) => setValue('ttsProviderId', v)}
          >
            <SelectTrigger className={triggerClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {configuredCloud.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ConfigItem>
      )}

      {ttsSource === 'cloud' && (
        <p className="text-xs text-muted-foreground w-full">
          {charCount != null && charCount > 0
            ? t('dubbing.cloudCostHint', { count: charCount })
            : t('dubbing.cloudPrivacyHint')}
        </p>
      )}

      <ConfigItem label={t('dubbing.durationStrategy')}>
        <Select
          value={formData?.durationStrategy || 'balanced'}
          onValueChange={(v) => setValue('durationStrategy', v)}
        >
          <SelectTrigger className={triggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="strict">
              {t('dubbing.strategy.strict')}
            </SelectItem>
            <SelectItem value="balanced">
              {t('dubbing.strategy.balanced')}
            </SelectItem>
            <SelectItem value="natural">
              {t('dubbing.strategy.natural')}
            </SelectItem>
          </SelectContent>
        </Select>
      </ConfigItem>

      <ConfigItem label={t('dubbing.outputModeLabel')}>
        <Select
          value={formData?.dubbingOutputMode || 'audioOnly'}
          onValueChange={(v) => setValue('dubbingOutputMode', v)}
        >
          <SelectTrigger className={triggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="audioOnly">
              {t('dubbing.outputMode.audioOnly')}
            </SelectItem>
            <SelectItem value="softMux">
              {t('dubbing.outputMode.softMux')}
            </SelectItem>
          </SelectContent>
        </Select>
      </ConfigItem>

      <ConfigItem label={t('dubbing.audioFormat')}>
        <Select
          value={formData?.dubbingOutputFormat || 'wav'}
          onValueChange={(v) => setValue('dubbingOutputFormat', v)}
        >
          <SelectTrigger className="h-8 w-[72px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="wav">WAV</SelectItem>
            <SelectItem value="mp3">MP3</SelectItem>
          </SelectContent>
        </Select>
      </ConfigItem>

      <div className="flex items-center gap-1.5">
        <Switch
          id="export-aligned-srt"
          className="scale-90"
          checked={formData?.exportAlignedSrt !== false}
          onCheckedChange={(v) => setValue('exportAlignedSrt', v)}
        />
        <label
          htmlFor="export-aligned-srt"
          className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap"
        >
          {t('dubbing.exportAlignedSrt')}
        </label>
      </div>
    </>
  );
};

export default DubbingConfigBar;

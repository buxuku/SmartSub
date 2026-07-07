import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Download,
  Trash2,
  X,
  Upload,
  Volume2,
  Play,
  Loader2,
  AudioLines,
} from 'lucide-react';
import { toast } from 'sonner';
import DownloadSourcePopover, {
  type DownloadSourceConfig,
} from '@/components/resources/engines/DownloadSourcePopover';
import SherpaModelRow from '@/components/resources/SherpaModelRow';
import { importModelFromFolder } from 'lib/importModel';
import { resolveModelDownloadUrl } from 'lib/resolveModelDownloadUrl';
import {
  getTtsVoices,
  getTtsDefaultVoice,
  groupTtsVoices,
  formatTtsVoiceLabel,
} from 'lib/ttsVoices';

type TtsModelId = 'kokoro-multi-lang-v1_1' | 'vits-zh-aishell3';

const TTS_MODEL_IDS: TtsModelId[] = [
  'kokoro-multi-lang-v1_1',
  'vits-zh-aishell3',
];

/** TTS 模型下载源（与主进程 TtsModelSource 一致）：国内优先 gh-proxy。 */
type TtsModelSource = 'ghproxy' | 'github';
const TTS_MODEL_SOURCES: TtsModelSource[] = ['ghproxy', 'github'];
const TTS_SOURCE_STORAGE_KEY = 'ttsModelDownloadSource';

function readTtsModelSource(): TtsModelSource {
  if (typeof window === 'undefined') return 'ghproxy';
  const v = window.localStorage.getItem(TTS_SOURCE_STORAGE_KEY);
  return v === 'github' || v === 'ghproxy' ? v : 'ghproxy';
}

interface TtsModelStatus {
  engineInstalled: boolean;
  ready: boolean;
  models: {
    id: TtsModelId;
    installed: boolean;
    meta: { numSpeakers: number; sampleRate: number; languages: string[] };
  }[];
}

const TtsModelSection: React.FC<{ onUpdate?: () => void }> = ({ onUpdate }) => {
  const { t } = useTranslation('resources');
  const { t: commonT } = useTranslation('common');

  const [status, setStatus] = useState<TtsModelStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState<TtsModelId | null>(null);
  const [confirmModel, setConfirmModel] = useState<TtsModelId | null>(null);
  const [deleteModel, setDeleteModel] = useState<TtsModelId | null>(null);
  const [source, setSource] = useState<TtsModelSource>('ghproxy');

  // 试听状态：按已装模型记忆选中音色；auditioning 期间按钮转圈。
  const [auditionModel, setAuditionModel] = useState<TtsModelId | null>(null);
  const [auditionSid, setAuditionSid] = useState<number>(0);
  const [auditioning, setAuditioning] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setSource(readTtsModelSource());
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  const handleSelectSource = useCallback((s: TtsModelSource) => {
    setSource(s);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(TTS_SOURCE_STORAGE_KEY, s);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await window?.ipc?.invoke('getTtsModelStatus');
      if (r?.success) {
        setStatus(r as TtsModelStatus);
        // 试听目标收敛到首个已装模型
        const installed = (r as TtsModelStatus).models.filter(
          (m) => m.installed,
        );
        setAuditionModel((prev) => {
          if (prev && installed.some((m) => m.id === prev)) return prev;
          const next = installed[0]?.id ?? null;
          if (next) setAuditionSid(getTtsDefaultVoice(next));
          return next;
        });
      }
    } catch {
      // 保持上次状态
    }
  }, []);

  useEffect(() => {
    load();
    const isTtsKey = (key: unknown): key is string =>
      typeof key === 'string' && key.startsWith('tts:');

    const unsub = window?.ipc?.on(
      'downloadProgress',
      (key: string, value: number) => {
        if (!isTtsKey(key)) return;
        setProgress((prev) => ({ ...prev, [key]: value }));
        if (value >= 1) {
          void load();
          onUpdate?.();
        }
      },
    );
    const unsubDetail = window?.ipc?.on(
      'modelDownloadDetail',
      (key: string, detail: { status?: string }) => {
        if (!isTtsKey(key)) return;
        setPhase((prev) => ({ ...prev, [key]: detail?.status ?? '' }));
      },
    );
    return () => {
      unsub?.();
      unsubDetail?.();
    };
  }, [load, onUpdate]);

  const isInstalled = (id: TtsModelId) =>
    status?.models.find((m) => m.id === id)?.installed ?? false;

  const sourceConfigFor = (id: TtsModelId): DownloadSourceConfig => ({
    value: source,
    options: TTS_MODEL_SOURCES.map((s) => ({
      value: s,
      label: t(`engines.tts.modelSources.${s}`),
    })),
    onChange: (s) => handleSelectSource(s as TtsModelSource),
    label: t('engines.tts.downloadSource'),
    confirmLabel: commonT('startDownload'),
    hint: t(`engines.tts.modelSourceHint.${source}`),
    getCopyUrl: (s) => resolveModelDownloadUrl('tts', s, id),
  });

  const doDownload = async (id: TtsModelId) => {
    setConfirmModel(null);
    setDownloading(id);
    try {
      const r = await window?.ipc?.invoke('downloadTtsModel', {
        model: id,
        source,
      });
      if (r?.success) {
        await load();
        onUpdate?.();
      } else {
        toast.error(
          r?.error === 'anotherDownloadInProgress'
            ? t('engines.tts.anotherDownload')
            : r?.error || 'Failed to download model',
        );
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDownloading(null);
      setProgress((prev) => ({ ...prev, [`tts:${id}`]: 0 }));
    }
  };

  const handleCancel = async () => {
    await window?.ipc?.invoke('cancelModelDownload');
    setDownloading(null);
  };

  const handleImport = async (id: TtsModelId) => {
    const o = await importModelFromFolder('tts', id);
    if (o.kind === 'success') {
      toast.success(t('importModelSuccess'), { duration: 2000 });
      await load();
      onUpdate?.();
    } else if (o.kind === 'invalid-layout') {
      toast.error(t('importInvalidLayout', { files: o.missing.join(', ') }));
    } else if (o.kind === 'error') {
      toast.error(t('importModelFailed', { error: o.message }));
    }
  };

  const handleDelete = async () => {
    if (!deleteModel) return;
    const id = deleteModel;
    setDeleteModel(null);
    const r = await window?.ipc?.invoke('deleteTtsModel', id);
    if (r?.success) {
      await load();
      onUpdate?.();
    } else {
      toast.error(r?.error || 'Failed to delete model');
    }
  };

  const handleAudition = async () => {
    if (!auditionModel || auditioning) return;
    setAuditioning(true);
    try {
      const r = await window?.ipc?.invoke('auditionTtsVoice', {
        model: auditionModel,
        sid: auditionSid,
      });
      if (r?.success && r.file) {
        audioRef.current?.pause();
        const audio = new Audio(`media://${encodeURIComponent(r.file)}`);
        audioRef.current = audio;
        await audio.play();
      } else {
        toast.error(r?.error || 'Audition failed');
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAuditioning(false);
    }
  };

  const auditionVoices = auditionModel ? getTtsVoices(auditionModel) : [];
  const voiceGroups = auditionModel
    ? groupTtsVoices(auditionModel, auditionVoices)
    : [];
  const voiceTrait = (key: string) => t(`engines.tts.${key}`);
  const installedModels = status?.models.filter((m) => m.installed) ?? [];

  const renderModelRow = (id: TtsModelId) => {
    const installed = isInstalled(id);
    const busy = downloading === id;
    const key = `tts:${id}`;
    return (
      <SherpaModelRow
        key={id}
        icon={AudioLines}
        name={t(`engines.tts.models.${id}.name`)}
        desc={t(`engines.tts.models.${id}.desc`)}
        installed={installed}
        busy={busy}
        progressPercent={Math.round((progress[key] ?? 0) * 100)}
        phaseText={
          phase[key] === 'extracting' ? t('engines.tts.extracting') : undefined
        }
        progressWidthClass="w-44"
        trailing={
          busy ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground"
              onClick={handleCancel}
            >
              <X className="h-3.5 w-3.5" />
              {commonT('cancel')}
            </Button>
          ) : installed ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground hover:text-destructive"
              onClick={() => setDeleteModel(id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('engines.tts.modelDelete')}
            </Button>
          ) : (
            <div className="flex items-center gap-1.5">
              <DownloadSourcePopover
                open={confirmModel === id}
                onOpenChange={(open) => setConfirmModel(open ? id : null)}
                config={sourceConfigFor(id)}
                onConfirm={() => doDownload(id)}
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={!!downloading}
                  onClick={() => setConfirmModel(id)}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t('engines.tts.modelDownload')}
                </Button>
              </DownloadSourcePopover>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-muted-foreground"
                disabled={!!downloading}
                onClick={() => handleImport(id)}
              >
                <Upload className="h-3.5 w-3.5" />
                {t('importFromFolder')}
              </Button>
            </div>
          )
        }
      />
    );
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-baseline gap-2 px-1">
          <AudioLines className="h-4 w-4 self-center text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t('engines.tts.modelsTitle')}
          </h3>
        </div>
        <Card>
          <CardContent className="space-y-2 p-2">
            {TTS_MODEL_IDS.map(renderModelRow)}
          </CardContent>
        </Card>
      </section>

      {installedModels.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2 px-1">
            <Volume2 className="h-4 w-4 self-center text-muted-foreground" />
            <h3 className="text-sm font-semibold">
              {t('engines.tts.auditionTitle')}
            </h3>
          </div>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              {installedModels.length > 1 && (
                <Select
                  value={auditionModel ?? undefined}
                  onValueChange={(v) => {
                    const id = v as TtsModelId;
                    setAuditionModel(id);
                    setAuditionSid(getTtsDefaultVoice(id));
                  }}
                >
                  <SelectTrigger className="h-8 w-48 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {installedModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {t(`engines.tts.models.${m.id}.name`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Select
                value={String(auditionSid)}
                onValueChange={(v) => setAuditionSid(Number(v))}
              >
                <SelectTrigger className="h-8 w-44 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {voiceGroups.map((group) => (
                    <SelectGroup key={group.key}>
                      <SelectLabel>
                        {t(`engines.tts.${group.labelKey}`)}
                      </SelectLabel>
                      {group.voices.map((v) => (
                        <SelectItem key={v.sid} value={String(v.sid)}>
                          {formatTtsVoiceLabel(
                            v,
                            auditionModel ?? undefined,
                            voiceTrait,
                          )}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={auditioning || !auditionModel}
                onClick={handleAudition}
              >
                {auditioning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {t('engines.tts.audition')}
              </Button>
              <p className="w-full text-xs text-muted-foreground">
                {t('engines.tts.auditionHint')}
              </p>
            </CardContent>
          </Card>
        </section>
      )}

      <AlertDialog
        open={!!deleteModel}
        onOpenChange={(open) => !open && setDeleteModel(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{commonT('confirmDeleteModel')}</AlertDialogTitle>
            <AlertDialogDescription>
              {commonT('deleteModelDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="gap-1.5">
              <X className="h-4 w-4" />
              {commonT('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" />
              {commonT('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TtsModelSection;

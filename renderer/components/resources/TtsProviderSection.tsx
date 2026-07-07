import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FlaskConical, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import useTtsProviders from 'hooks/useTtsProviders';
import {
  TTS_OPENAI_COMPATIBLE,
  getTtsPresetsForType,
  getTtsProviderType,
  isTtsProviderConfigured,
  type TtsProvider,
} from '../../../types/ttsProvider';

const TtsProviderSection: React.FC = () => {
  const { t } = useTranslation('resources');
  const api = useTtsProviders();
  const type = getTtsProviderType(TTS_OPENAI_COMPATIBLE)!;
  const presets = getTtsPresetsForType(TTS_OPENAI_COMPATIBLE);

  const [selectedId, setSelectedId] = useState<string>('');
  const [testing, setTesting] = useState(false);

  const instances = useMemo(
    () => api.providers.filter((p) => p.type === TTS_OPENAI_COMPATIBLE),
    [api.providers],
  );

  const selected = instances.find((p) => p.id === selectedId) ?? instances[0];

  useEffect(() => {
    if (selected?.id && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected?.id, selectedId]);

  const handleAdd = (presetId?: string) => {
    const id = api.addInstance(TTS_OPENAI_COMPATIBLE, presetId);
    if (id) setSelectedId(id);
  };

  const updateField = (key: string, value: string) => {
    if (!selected) return;
    api.updateInstanceField(selected.id, key, value);
  };

  const handleTest = async () => {
    if (!selected) return;
    setTesting(true);
    try {
      const res = (await window?.ipc?.invoke('testTtsProvider', selected)) as {
        ok?: boolean;
        needsConfig?: boolean;
        detail?: string;
      };
      if (res?.needsConfig) {
        toast.error(t('tts.needsConfig'));
        return;
      }
      if (res?.ok) toast.success(t('tts.testOk'));
      else toast.error(res?.detail || t('tts.testFailed'));
    } finally {
      setTesting(false);
    }
  };

  const renderField = (field: (typeof type.fields)[number]) => {
    const value = String(selected?.[field.key] ?? field.defaultValue ?? '');
    if (field.type === 'select' && field.options) {
      return (
        <Select value={value} onValueChange={(v) => updateField(field.key, v)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    return (
      <Input
        className="h-8 text-xs"
        type={field.type === 'password' ? 'password' : 'text'}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => updateField(field.key, e.target.value)}
      />
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center justify-between gap-2">
          <span>{t('tts.cloudTitle')}</span>
          <div className="flex gap-1">
            {presets.map((p) => (
              <Button
                key={p.id}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => handleAdd(p.id)}
              >
                <Plus className="h-3 w-3 mr-1" />
                {p.name}
              </Button>
            ))}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {instances.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('tts.emptyHint')}</p>
        ) : (
          <>
            <Select value={selected?.id} onValueChange={setSelectedId}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {instances.map((p: TtsProvider) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {isTtsProviderConfigured(p, type)
                      ? ` · ${t('tts.configured')}`
                      : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {type.fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  {t(field.label, { defaultValue: field.label })}
                </label>
                {renderField(field)}
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1"
                disabled={testing || !selected}
                onClick={handleTest}
              >
                {testing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FlaskConical className="h-3.5 w-3.5" />
                )}
                {t('tts.testConnection')}
              </Button>
              {selected && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs gap-1 text-destructive"
                  onClick={() => {
                    api.removeInstance(selected.id);
                    setSelectedId('');
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('tts.remove')}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default TtsProviderSection;

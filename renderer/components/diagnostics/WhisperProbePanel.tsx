import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type {
  WhisperProbeOptions,
  WhisperProbeRequest,
  WhisperProbeResult,
} from '../../../types/whisperProbe';

export function WhisperProbePanel({
  options,
  onRunningChange,
}: {
  options: WhisperProbeOptions;
  onRunningChange: (running: boolean) => void;
}) {
  const { t } = useTranslation('common');
  const [model, setModel] = useState(options.defaultModel);
  const [backend, setBackend] = useState<WhisperProbeRequest['backend']>(
    options.backends[0],
  );
  const [vad, setVad] = useState(options.vad);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WhisperProbeResult | null>(null);
  const [error, setError] = useState('');
  const runningRef = useRef(false);
  useEffect(
    () => () => {
      if (runningRef.current) {
        void window.ipc
          .invoke('diagnostics:whisper-probe-cancel')
          .catch(() => {});
        onRunningChange(false);
      }
    },
    [onRunningChange],
  );
  const run = async () => {
    runningRef.current = true;
    setRunning(true);
    onRunningChange(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await window.ipc.invoke('diagnostics:whisper-probe', {
          model,
          backend,
          vad,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      runningRef.current = false;
      setRunning(false);
      onRunningChange(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="font-medium">{t('diagnostics.probe.title')}</p>
      <p className="text-xs text-muted-foreground">
        {t('diagnostics.probe.description')}
      </p>
      {!options.models.length || !options.backends.length ? (
        <p className="text-xs text-muted-foreground">
          {t('diagnostics.probe.unavailable')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 text-xs">
              {t('diagnostics.probe.model')}
              <select
                className="rounded border bg-background p-1.5 text-sm"
                value={model}
                disabled={running}
                onChange={(e) => setModel(e.target.value)}
              >
                {options.models.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t('diagnostics.probe.backend')}
              <select
                className="rounded border bg-background p-1.5 text-sm"
                value={backend}
                disabled={running}
                onChange={(e) =>
                  setBackend(e.target.value as WhisperProbeRequest['backend'])
                }
              >
                {options.backends.map((name) => (
                  <option key={name} value={name}>
                    {name === 'vulkan' ? 'Vulkan' : 'CPU'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={vad}
              disabled={running}
              onCheckedChange={setVad}
            />
            <span>{t('diagnostics.probe.vad')}</span>
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={running}
            onClick={() => void run()}
          >
            {t('diagnostics.probe.run')}
          </Button>
          {running && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void window.ipc
                  .invoke('diagnostics:whisper-probe-cancel')
                  .catch((e: unknown) => setError(String(e)));
              }}
            >
              {t('cancel')}
            </Button>
          )}
          {running && (
            <p role="status" className="text-xs">
              {t('diagnostics.probe.running')}
            </p>
          )}
          {result && (
            <p role="status" className="text-xs">
              {t(`diagnostics.probe.${result.status}`)}{' '}
              {t('diagnostics.probe.saved')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

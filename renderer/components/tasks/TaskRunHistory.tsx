import { useState } from 'react';
import { useTranslation } from 'next-i18next';
import type { TaskRun } from '../../../types/taskRun';
import { isRunLocked } from '../../../types/taskRun';
import { Button } from '../ui/button';

export function TaskRunHistory({
  runs,
  editing,
  onEdit,
}: {
  runs: TaskRun[];
  editing: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation('tasks');
  const [selected, setSelected] = useState('');
  if (!runs.length) return null;
  const current = runs[0];
  const historical = runs.find(
    (run) => run.runId === selected && run.runId !== current.runId,
  );
  return (
    <div className="rounded-lg border p-3 mb-3 text-sm space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span>
          {t('runs.current')} · {t(`runs.status.${current.status}`)}
        </span>
        <label className="flex items-center gap-2">
          {t('runs.history')}
          <select
            aria-label={t('runs.history')}
            className="rounded border bg-background p-1"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">{t('runs.current')}</option>
            {runs.slice(1).map((run, index) => (
              <option key={run.runId} value={run.runId}>
                {runs.length - index - 1} ·{' '}
                {new Date(run.createdAt).toLocaleString()} ·{' '}
                {t(`runs.status.${run.status}`)}
              </option>
            ))}
          </select>
        </label>
        {!isRunLocked(current) && !editing && (
          <Button size="sm" variant="outline" onClick={onEdit}>
            {t('runs.editNext')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          editing
            ? 'runs.draftHint'
            : isRunLocked(current)
              ? 'runs.lockedHint'
              : 'runs.resultHint',
        )}
      </p>
      {historical && (
        <details open>
          <summary>
            {t('runs.readOnly')} ·{' '}
            {new Date(historical.createdAt).toLocaleString()}
          </summary>
          <div className="max-h-72 overflow-auto mt-2 space-y-3">
            {historical.legacy && (
              <p className="text-xs text-muted-foreground">
                {t('runs.legacyHint')}
              </p>
            )}
            {historical.files.map((file) => (
              <div key={file.fileId}>
                <strong>{file.input.fileName}</strong>
                <ul>
                  {Object.values(file.stages).map((stage) => (
                    <li key={stage.id} className="text-xs">
                      {t(`runs.stages.${stage.id}`, { defaultValue: stage.id })}
                      :{' '}
                      {t(`runs.outcome.${stage.outcome || stage.status}`, {
                        defaultValue: stage.status,
                      })}
                      {stage.reason && ` · ${stage.reason}`}
                    </li>
                  ))}
                </ul>
                {[
                  ...(file.projection.sourceSubtitleFiles || []),
                  ...(file.projection.translatedSubtitleFiles || []),
                  file.projection.finalVideoPath,
                  file.projection.dubbedAudioPath,
                ]
                  .filter(Boolean)
                  .map((target) => (
                    <p key={target} className="text-xs break-all select-text">
                      {target}
                    </p>
                  ))}
              </div>
            ))}
            <details>
              <summary>{t('runs.configuration')}</summary>
              <pre className="whitespace-pre-wrap text-xs">
                {JSON.stringify(historical.config, null, 2)}
              </pre>
            </details>
          </div>
        </details>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useTranslation } from 'next-i18next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { getStaticPaths, makeStaticProperties } from '../../lib/get-static';
import {
  getWorkItemStatus,
  getWorkItemTypeLabel,
} from '../../lib/workItemUtils';
import type { WorkItem } from '../../../types/workItem';

export default function ProcessingResultPage() {
  const router = useRouter();
  const locale =
    typeof router.query.locale === 'string' ? router.query.locale : 'zh';
  const id =
    typeof router.query.workItem === 'string' ? router.query.workItem : '';
  const { t } = useTranslation('launchpad');
  const { t: tToolbox } = useTranslation('toolbox');
  const [item, setItem] = useState<WorkItem | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!id) {
      setItem(null);
      setError(t('result.unavailable'));
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setItem(null);
    setError('');
    const load = async () => {
      try {
        const result = await window.ipc.invoke('getWorkItem', id);
        if (disposed) return;
        if (!result || !['compose', 'toolbox'].includes(result.type))
          throw new Error(t('result.unavailable'));
        setItem(result);
        if (['running', 'waiting'].includes(result.status))
          timer = setTimeout(load, 1500);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [id, attempt, t]);

  const openFile = async (filePath: string) => {
    try {
      const exists = await window.ipc.invoke('checkFileExists', { filePath });
      if (!exists?.exists)
        throw new Error(t('result.fileMissing', { path: filePath }));
      if (!(await window.ipc.invoke('toolbox:openFolder', filePath)))
        throw new Error(t('result.openFailed'));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const toolId = item?.processing?.toolId;
  const compose = item?.configSnapshot as
    | { videoPath?: string; subtitle?: { subtitlePath?: string } }
    | undefined;
  const resume =
    item?.type === 'compose'
      ? `/${locale}/subtitleMerge?${new URLSearchParams({ video: compose?.videoPath || '', subtitle: compose?.subtitle?.subtitlePath || '' })}`
      : `/${locale}/toolbox?tool=${encodeURIComponent(toolId || '')}`;

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <Link
        className="text-sm text-primary underline"
        href={`/${locale}/recent-tasks`}
      >
        {t('result.back')}
      </Link>
      {error && (
        <div
          role="alert"
          className="space-y-2 rounded bg-destructive/10 p-3 text-sm"
        >
          <p className="break-all">{error}</p>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            {t('result.retry')}
          </Button>
        </div>
      )}
      {!item && !error && <p role="status">{t('result.loading')}</p>}
      {item && (
        <>
          <div>
            <h1 className="break-all text-lg font-semibold">{item.name}</h1>
            <p className="text-sm text-muted-foreground">
              {toolId
                ? tToolbox(`tools.${toolId}.name`)
                : getWorkItemTypeLabel(item, t, t)}{' '}
              · {t(`status.${getWorkItemStatus(item)}`)}
            </p>
          </div>
          {item.processing?.error && (
            <p
              role="alert"
              className="whitespace-pre-wrap break-words text-sm text-destructive"
            >
              {item.processing.error}
            </p>
          )}
          <section className="space-y-2">
            <h2 className="font-medium">{t('result.outputs')}</h2>
            {!item.artifacts?.length && (
              <p className="text-sm text-muted-foreground">
                {t('result.noOutputs')}
              </p>
            )}
            {item.artifacts?.map((artifact) => (
              <div
                key={artifact.path}
                className="flex items-center gap-3 rounded border p-3"
              >
                <span className="min-w-0 flex-1 break-all text-sm">
                  {artifact.path}
                </span>
                <Button
                  variant="outline"
                  onClick={() => void openFile(artifact.path)}
                >
                  {t('result.openFolder')}
                </Button>
              </div>
            ))}
          </section>
          <section className="space-y-2">
            <h2 className="font-medium">{t('result.inputs')}</h2>
            {item.processing?.inputPaths.map((filePath) => (
              <p
                key={filePath}
                className="break-all text-sm text-muted-foreground"
              >
                {filePath}
              </p>
            ))}
          </section>
          <Link
            href={resume}
            className="self-start text-sm text-primary underline"
          >
            {t(
              item.type === 'compose'
                ? 'result.openCompose'
                : 'result.openTool',
            )}
          </Link>
        </>
      )}
    </div>
  );
}

export const getStaticProps = makeStaticProperties([
  'common',
  'launchpad',
  'toolbox',
]);
export { getStaticPaths };

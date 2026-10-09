import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SuppressedBackendInfo } from '../../../../types/diagnostics';
import { suppressedBackendLabel } from './gpuUtils';

/**
 * 因崩溃被自动停用的加速后端：说明停用了什么、为什么，并允许手动重新尝试。
 * 没有被停用的后端时什么也不渲染，不占位置。
 */
const SuppressedBackends: React.FC = () => {
  const { t } = useTranslation('settings');
  const [items, setItems] = useState<SuppressedBackendInfo[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.ipc
      .invoke('get-suppressed-backends')
      .then((list: SuppressedBackendInfo[]) => {
        if (!cancelled && Array.isArray(list)) setItems(list);
      })
      .catch(() => {
        // 读不到就当没有：这只是个提示，不影响使用
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const retry = useCallback(async () => {
    setBusy(true);
    try {
      await window.ipc.invoke('reset-suppressed-backends');
      setItems([]);
      toast.success(t('gpuAcceleration.suppressed.retried'));
      // 缓存已清，让头部的加速徽章等跟着刷新
      window.dispatchEvent(new Event('gpu-settings-changed'));
    } catch (error) {
      toast.error(
        t('gpuAcceleration.suppressed.retryFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [t]);

  if (items.length === 0) return null;

  const reasonText = (item: SuppressedBackendInfo) =>
    item.reason === 'isa'
      ? t('gpuAcceleration.suppressed.reasonIsa')
      : item.evidence === 'weak'
        ? t('gpuAcceleration.suppressed.reasonWeak')
        : t('gpuAcceleration.suppressed.reasonCrash');

  return (
    <div
      data-testid="suppressed-backends"
      className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t('gpuAcceleration.suppressed.title')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('gpuAcceleration.suppressed.description')}
          </p>
        </div>
      </div>
      <ul className="list-disc space-y-1 pl-9 text-xs">
        {items.map((item) => (
          <li key={`${item.scope}:${item.key}`}>
            <span className="font-medium">
              {item.scope === 'family'
                ? t('gpuAcceleration.suppressed.family')
                : suppressedBackendLabel(item.key)}
            </span>
            {' — '}
            {reasonText(item)}
            {item.detail && (
              <span className="block text-muted-foreground">
                {t('gpuAcceleration.suppressed.detail', {
                  detail: item.detail,
                })}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="pl-6">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => void retry()}
        >
          {t('gpuAcceleration.suppressed.retry')}
        </Button>
      </div>
    </div>
  );
};

export default SuppressedBackends;

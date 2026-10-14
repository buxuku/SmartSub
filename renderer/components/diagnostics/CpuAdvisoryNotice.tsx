import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { ExternalLink, Info, ShieldAlert } from 'lucide-react';
import { cn, openUrl } from 'lib/utils';
import { LEGACY_CPU_PACK_URL, canUseLegacyCpuPack } from 'lib/legacyCpuPack';
import type { CpuAdvisory } from '../../../types/cpuAdvisory';

interface Notice {
  key: string;
  /** warn = 可能闪退的警告；info = 已经处理过的状态说明 */
  tone: 'warn' | 'info';
  title: string;
  description: string;
  /** 补充的一段说明（兼容包这条出路） */
  extra?: string;
  action?: { label: string; url: string };
}

/** 用户当前设置的自定义加速包路径；读不到就当没有设置。 */
async function readCustomAddonPath(): Promise<string | null> {
  try {
    const path = await window.ipc.invoke('get-custom-addon-path');
    return typeof path === 'string' && path ? path : null;
  } catch {
    return null;
  }
}

/**
 * CPU 指令集预警：内置语音识别的预编译加速包需要 AVX2 等指令集，缺了会在加载或转写时闪退。
 * 只在“明确缺失”或“x64 版本在 ARM 转译下运行”时出现，探测不到（unknown）一律不打扰；
 * 只是提醒，不阻止任何操作。
 *
 * 缺 AVX2 但还有 AVX 的 Windows / Linux 电脑多一条实验性的出路：旧 CPU 兼容包。
 * 下载和导入的步骤写在它的发布页上，这里只放一个链接。用户导入自定义加速包之后，
 * 这条提示改成状态说明，不再催着去下载。
 */
const CpuAdvisoryNotice: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('common');
  const [state, setState] = useState<{
    advisory: CpuAdvisory;
    customAddonPath: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.ipc.invoke('get-cpu-advisory') as Promise<CpuAdvisory | null>,
      readCustomAddonPath(),
    ])
      .then(([advisory, customAddonPath]) => {
        if (!cancelled && advisory) setState({ advisory, customAddonPath });
      })
      .catch(() => {
        // 读不到就当没有：这只是个提示，不影响使用
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 旁边的“自定义加速包”选好或清除文件后，GPU 卡片会广播这个事件：跟着刷新，不要留着过期的提示
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void readCustomAddonPath().then((customAddonPath) => {
        if (cancelled) return;
        setState((prev) => (prev ? { ...prev, customAddonPath } : prev));
      });
    };
    window.addEventListener('gpu-settings-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('gpu-settings-changed', refresh);
    };
  }, []);

  if (!state) return null;
  const { advisory, customAddonPath } = state;

  const notices: Notice[] = [];
  if (advisory.missing.length > 0) {
    const features = advisory.missing
      .map((feature) => feature.toUpperCase())
      .join(', ');
    const legacyPack = canUseLegacyCpuPack(advisory);
    if (legacyPack && customAddonPath) {
      notices.push({
        key: 'missing',
        tone: 'info',
        title: t('cpuAdvisory.missing.customAddon.title'),
        description: t('cpuAdvisory.missing.customAddon.description', {
          features,
        }),
      });
    } else {
      notices.push({
        key: 'missing',
        tone: 'warn',
        title: t('cpuAdvisory.missing.title'),
        description: t('cpuAdvisory.missing.description', { features }),
        ...(legacyPack
          ? {
              extra: t('cpuAdvisory.missing.legacyPack.description'),
              action: {
                label: t('cpuAdvisory.missing.legacyPack.action'),
                url: LEGACY_CPU_PACK_URL,
              },
            }
          : {}),
      });
    }
  }
  if (advisory.translated) {
    notices.push({
      key: 'translated',
      tone: 'warn',
      title: t('cpuAdvisory.translated.title'),
      description: t(
        advisory.platform === 'darwin'
          ? 'cpuAdvisory.translated.descriptionMac'
          : 'cpuAdvisory.translated.descriptionOther',
      ),
    });
  }
  if (notices.length === 0) return null;

  return (
    <div data-testid="cpu-advisory" className={cn('space-y-2', className)}>
      {notices.map((notice) => {
        const info = notice.tone === 'info';
        const Icon = info ? Info : ShieldAlert;
        const action = notice.action;
        return (
          <div
            key={notice.key}
            role="note"
            className={cn(
              'flex items-start gap-2 rounded-md border p-3',
              info
                ? 'border-border bg-muted/50'
                : 'border-amber-500/40 bg-amber-500/5',
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                info ? 'text-muted-foreground' : 'text-amber-600',
              )}
            />
            <div className="space-y-1">
              <p className="text-sm font-medium">{notice.title}</p>
              <p className="text-xs text-muted-foreground">
                {notice.description}
              </p>
              {notice.extra && (
                <p className="text-xs text-muted-foreground">{notice.extra}</p>
              )}
              {action && (
                <button
                  type="button"
                  onClick={() => openUrl(action.url)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline cursor-pointer"
                >
                  <ExternalLink className="h-3 w-3" />
                  {action.label}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default CpuAdvisoryNotice;

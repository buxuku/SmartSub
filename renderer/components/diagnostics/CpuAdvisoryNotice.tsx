import React, { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { ShieldAlert } from 'lucide-react';
import { cn } from 'lib/utils';
import type { CpuAdvisory } from '../../../types/cpuAdvisory';

/**
 * CPU 指令集预警：内置语音识别的预编译加速包需要 AVX2 等指令集，缺了会在加载或转写时闪退。
 * 只在“明确缺失”或“x64 版本在 ARM 转译下运行”时出现，探测不到（unknown）一律不打扰；
 * 只是提醒，不阻止任何操作。
 */
const CpuAdvisoryNotice: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('common');
  const [advisory, setAdvisory] = useState<CpuAdvisory | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.ipc
      .invoke('get-cpu-advisory')
      .then((result: CpuAdvisory | null) => {
        if (!cancelled && result) setAdvisory(result);
      })
      .catch(() => {
        // 读不到就当没有：这只是个提示，不影响使用
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!advisory) return null;

  const notices: Array<{ key: string; title: string; description: string }> =
    [];
  if (advisory.missing.length > 0) {
    notices.push({
      key: 'missing',
      title: t('cpuAdvisory.missing.title'),
      description: t('cpuAdvisory.missing.description', {
        features: advisory.missing
          .map((feature) => feature.toUpperCase())
          .join(', '),
      }),
    });
  }
  if (advisory.translated) {
    notices.push({
      key: 'translated',
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
      {notices.map((notice) => (
        <div
          key={notice.key}
          role="note"
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="text-sm font-medium">{notice.title}</p>
            <p className="text-xs text-muted-foreground">
              {notice.description}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
};

export default CpuAdvisoryNotice;

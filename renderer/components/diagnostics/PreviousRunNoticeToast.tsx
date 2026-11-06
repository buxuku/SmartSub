import { useEffect, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import type { PreviousRunNotice } from '../../../types/diagnostics';
import { suppressedBackendLabel } from '../settings/gpu/gpuUtils';

/** 提示里带“导出诊断包”按钮，给用户足够的时间看到并点击。 */
const NOTICE_DURATION_MS = 30000;

/** 因这次崩溃被自动停用的后端说明；没有停用时返回空串。 */
function suppressedLine(
  notice: PreviousRunNotice,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const list = notice.suppressed ?? [];
  if (list.length === 0) return '';
  if (list.some((item) => item.scope === 'family')) {
    return t('diagnostics.previousRun.suppressedFamily');
  }
  const backends = Array.from(
    new Set(list.map((item) => suppressedBackendLabel(item.key))),
  ).join(t('diagnostics.previousRun.listSeparator'));
  return t('diagnostics.previousRun.suppressedBackends', { backends });
}

/**
 * 上次运行异常结束、并且主进程找到了崩溃证据时，弹一次提示并引导导出诊断包。
 * 没有证据（强杀、安装程序关闭、断电）时主进程不会给出提示，这里什么也不显示。
 *
 * 拉取式：挂载后主动问主进程要，避免主进程比窗口先就绪时推送被丢掉。
 * 取到后立刻通知主进程“已展示”，刷新页面或切换语言都不会重复弹。
 */
export function PreviousRunNoticeToast() {
  const { t } = useTranslation('common');
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let cancelled = false;
    window.ipc
      .invoke('crash:previous-run-notice')
      .then((notice: PreviousRunNotice | null) => {
        // 开发模式下组件会被挂载两次：被取消的那一次不能把提示“吃掉”
        if (cancelled || !notice) return;
        const detail = [notice.label, notice.faultModule]
          .filter(Boolean)
          .join(' · ');
        const translate = tRef.current;
        const base = detail
          ? translate('diagnostics.previousRun.descriptionDetail', { detail })
          : translate('diagnostics.previousRun.description');
        const extra = suppressedLine(notice, translate);
        toast.warning(translate('diagnostics.previousRun.title'), {
          description: extra ? `${base}\n${extra}` : base,
          // 多了一行“已停用的后端”时按换行显示
          ...(extra
            ? { classNames: { description: 'whitespace-pre-line' } }
            : {}),
          duration: NOTICE_DURATION_MS,
          action: {
            label: translate('diagnostics.previousRun.action'),
            onClick: () =>
              window.dispatchEvent(new CustomEvent('app-open-diagnostics')),
          },
        });
        return window.ipc.invoke('crash:dismiss-previous-run-notice');
      })
      .catch(() => {
        // 拿不到提示不影响使用
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}

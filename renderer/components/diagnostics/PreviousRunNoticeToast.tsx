import { useEffect, useRef } from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import type { PreviousRunNotice } from '../../../types/diagnostics';

/** 提示里带“导出诊断包”按钮，给用户足够的时间看到并点击。 */
const NOTICE_DURATION_MS = 30000;

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
        toast.warning(translate('diagnostics.previousRun.title'), {
          description: detail
            ? translate('diagnostics.previousRun.descriptionDetail', { detail })
            : translate('diagnostics.previousRun.description'),
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

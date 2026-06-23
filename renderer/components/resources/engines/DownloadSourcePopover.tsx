import React, { createContext, useContext, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { Copy, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import DownloadSourceSelector, {
  DownloadSourceOption,
} from '@/components/resources/engines/DownloadSourceSelector';

/** 下载源配置：在「点击下载」时于气泡内选择，不常驻占位。 */
export interface DownloadSourceConfig {
  value: string;
  options: DownloadSourceOption[];
  onChange: (value: string) => void;
  /** 选择器标题，如「下载源」。 */
  label: string;
  /** 确认按钮文案，如「开始下载」。 */
  confirmLabel: string;
  hint?: string;
  /**
   * 可选：按「当前所选源」返回可复制的下载链接。
   * 提供时气泡内会在「开始下载」左侧显示复制按钮，复制内容随选中源自动切换。
   * 返回 null/undefined 表示该源无可复制链接（复制按钮按下时给出失败提示）。
   */
  getCopyUrl?: (
    source: string,
  ) => string | null | undefined | Promise<string | null | undefined>;
}

/**
 * 下载源在「点击下载时」才选择：上下文携带源配置，由真正发起下载的叶子组件
 * （DownModel / FunasrModelSection）消费并就地弹出 Popover。Provider 之外
 * （设置页 / 引导页等）取到 null，行为保持原样（直接下载）。
 */
const DownloadSourceContext = createContext<DownloadSourceConfig | null>(null);

export const DownloadSourceProvider = DownloadSourceContext.Provider;

export function useDownloadSource(): DownloadSourceConfig | null {
  return useContext(DownloadSourceContext);
}

interface DownloadSourcePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: DownloadSourceConfig;
  onConfirm: () => void;
  /** 作为锚点的触发元素（下载按钮），需可转发 ref。 */
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  /**
   * 可选：按「当前所选源」返回可复制链接。优先级高于 config.getCopyUrl，
   * 供「一份共享 config 对应多模型」的场景（ModelLibrarySection / Funasr 各行）
   * 由叶子按本行模型就地提供。
   */
  getCopyUrl?: DownloadSourceConfig['getCopyUrl'];
}

/**
 * 「下载源」气泡：以传入的触发元素为锚点，内含分段选源 + 复制链接 + 「开始下载」。
 * 点击确认即关闭并发起下载；复制按钮按当前选中源解析链接并写入剪贴板（不关闭气泡）。
 * 零常驻占位，符合「点下载再选」。
 */
const DownloadSourcePopover: React.FC<DownloadSourcePopoverProps> = ({
  open,
  onOpenChange,
  config,
  onConfirm,
  children,
  align = 'end',
  getCopyUrl: getCopyUrlProp,
}) => {
  const { t } = useTranslation('modelsControl');
  const [copying, setCopying] = useState(false);
  const getCopyUrl = getCopyUrlProp ?? config.getCopyUrl;

  const handleCopy = async () => {
    if (!getCopyUrl || copying) return;
    setCopying(true);
    try {
      const url = await Promise.resolve(getCopyUrl(config.value));
      if (!url) {
        toast.error(t('copyError'), { duration: 2000 });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success(t('copySuccess'), { duration: 2000 });
    } catch {
      toast.error(t('copyError'), { duration: 2000 });
    } finally {
      setCopying(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent align={align} className="w-80 space-y-3">
        <DownloadSourceSelector
          label={config.label}
          value={config.value}
          options={config.options}
          onChange={config.onChange}
          hint={config.hint}
        />
        <div className="flex items-center gap-2">
          {getCopyUrl && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 shrink-0 p-0"
              onClick={handleCopy}
              disabled={copying}
              aria-label={t('copyLink')}
              title={t('copyLink')}
            >
              <Copy className="h-4 w-4" />
            </Button>
          )}
          <Button
            size="sm"
            className="flex-1 gap-1.5"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            <Download className="h-4 w-4" />
            {config.confirmLabel}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default DownloadSourcePopover;

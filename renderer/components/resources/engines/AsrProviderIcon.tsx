import React from 'react';
import { Plug } from 'lucide-react';
import { cn } from 'lib/utils';
import type { AsrProviderType } from '../../../../types/asrProvider';

/**
 * 云端听写服务商的品牌图标：logo 统一放白色圆角底上（对齐翻译服务商列表的
 * ProviderIcon 约定），保证深色模式与选中态下清晰可见；无 logo 回落 emoji，
 * 孤儿类型（无 icon 定义）回落通用插头图标。
 */
const AsrProviderIcon: React.FC<{
  type: Pick<AsrProviderType, 'icon' | 'iconImg'>;
  className?: string;
}> = ({ type, className }) => (
  <span
    className={cn(
      'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-white ring-1 ring-black/[0.08] dark:ring-white/20',
      className,
    )}
  >
    {type.iconImg ? (
      <img src={type.iconImg} alt="" className="h-4 w-4 object-contain" />
    ) : type.icon ? (
      <span className="text-sm leading-none">{type.icon}</span>
    ) : (
      <Plug className="h-3.5 w-3.5 text-zinc-500" />
    )}
  </span>
);

export default AsrProviderIcon;

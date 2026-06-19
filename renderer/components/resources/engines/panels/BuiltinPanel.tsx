import React from 'react';
import { useTranslation } from 'next-i18next';
import { GpuAccelerationCard } from '@/components/settings';

/**
 * builtin（whisper.cpp）引擎面板。
 *
 * GPU 加速（whisper.cpp 的 CUDA/Vulkan addon）只服务本引擎，故折叠进此面板内联呈现
 * （`variant="embedded"`：紧凑状态摘要常驻 + 「管理/高级」默认收起；CUDA 下载抽屉从页面内
 * 打开，绝不出现弹窗内再开抽屉的嵌套）。
 */
const BuiltinPanel: React.FC = () => {
  const { t } = useTranslation('resources');
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('engines.builtin.desc')}
      </p>
      <div className="border-t pt-4">
        <GpuAccelerationCard variant="embedded" />
      </div>
    </div>
  );
};

export default BuiltinPanel;

import React from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'next-i18next';
import { translateContentLabelKey } from 'lib/translateContentLabel';

interface ComposeContentHintProps {
  /** 本次任务是否翻译；不翻译时成片取源字幕，「输出内容」不影响它 */
  translateOn: boolean;
  composeSubtitle: 'hard' | 'soft' | 'none';
  /** 表单里的「输出内容」；未设置时与主进程一致，按仅译文处理 */
  translateContent: unknown;
}

/**
 * 成品视频取字幕的优先级是「顺延版 → 译文交付物 → 源字幕」（见 pickComposeSubtitle），
 * 所以开启翻译后，烧进或封装进成片的文字就是「输出内容」所选的样式。
 * 硬字幕压进画面后无法再改回，因此在合成面板里直接说明，免得双语样式悄悄进入成片。
 */
export default function ComposeContentHint({
  translateOn,
  composeSubtitle,
  translateContent,
}: ComposeContentHintProps) {
  const { t } = useTranslation('tasks');
  if (!translateOn || composeSubtitle === 'none') return null;
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <Info className="h-3 w-3" />
      {t('wizard.composeContentHint', {
        content: t(`home:${translateContentLabelKey(translateContent)}`),
      })}
    </span>
  );
}

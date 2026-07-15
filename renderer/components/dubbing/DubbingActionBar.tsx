/**
 * 文件条右端操作簇（内容区右上角）：字符预估 + 阶段化按钮（开始/继续/重跑 + 导出）
 * + 合成进度。导出恒在最右（最后一步），合成类按钮在其左侧，主次随阶段切换。
 * 导出成功用全局 toast 通知；结果横幅由 DubbingPanel 渲染在文件条下方。
 */
import React from 'react';
import { useTranslation } from 'next-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Play, Square, RotateCcw, Loader2, Download, Info } from 'lucide-react';
import type { UseDubbingReturn } from '../../hooks/useDubbing';
import {
  TTS_AZURE_SPEECH,
  TTS_ELEVENLABS,
  TTS_VOLCENGINE,
} from '../../../types/ttsProvider';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export default function DubbingActionBar({
  dub,
  hideExport = false,
}: {
  dub: UseDubbingReturn;
  /** 检查员模式：产出由任务的合成阶段负责，隐藏导出入口 */
  hideExport?: boolean;
}) {
  const { t } = useTranslation('dubbing');
  const {
    running,
    exporting,
    percent,
    cancel,
    isCancelling,
    start,
    canStart,
    canExport,
    exportDubbing,
    openOutputFolder,
    summary,
    charEstimate,
    activeEngine,
  } = dub;

  const allDone = summary.total > 0 && summary.done === summary.total;
  // 有可导出的结果（含过长行，与 canExport 同口径）才展示导出按钮。
  const hasResults = summary.done + summary.overlong > 0;
  // 全部完成时重跑为全量口径，否则按剩余待合成口径预估。
  const estRows = allDone ? charEstimate.totalRows : charEstimate.pendingRows;
  const estChars = allDone
    ? charEstimate.totalChars
    : charEstimate.pendingChars;
  // 云端引擎：叠加计费口径提示（Azure 含 SSML 附加 / ElevenLabs 字节膨胀 / 豆包字符版）。
  const billingHint =
    activeEngine?.kind === 'cloud'
      ? [
          t('charBillingCloud'),
          activeEngine.providerType === TTS_AZURE_SPEECH
            ? t('charBillingAzure')
            : null,
          activeEngine.providerType === TTS_ELEVENLABS
            ? t('charBillingEleven')
            : null,
          activeEngine.providerType === TTS_VOLCENGINE
            ? t('charBillingVolc')
            : null,
        ]
          .filter(Boolean)
          .join('\n')
      : undefined;

  const handleExport = async () => {
    const result = await exportDubbing();
    if (result) {
      toast.success(t('exportDone'), {
        description: baseName(result.outputPath),
        action: {
          label: t('openFolder'),
          onClick: () => {
            openOutputFolder();
          },
        },
      });
    }
  };

  if (running) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex w-40 items-center gap-2">
          <Progress value={percent} className="h-2" />
          <span className="text-xs tabular-nums text-muted-foreground">
            {percent}%
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={cancel}
          disabled={isCancelling}
        >
          {isCancelling ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Square className="mr-1 h-3.5 w-3.5" />
          )}
          {t('cancel')}
        </Button>
      </div>
    );
  }

  const exportButton = (variant: 'default' | 'outline') =>
    hideExport ? null : (
      <Button
        variant={variant}
        size="sm"
        onClick={handleExport}
        disabled={!canExport}
      >
        {exporting ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="mr-1 h-3.5 w-3.5" />
        )}
        {t('export')}
      </Button>
    );

  return (
    <div className="flex items-center gap-2">
      {/* 合成字符量预估（云端引擎附计费口径提示） */}
      {estRows > 0 && (
        <span
          className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
          title={billingHint}
        >
          {t('charEstimate', {
            rows: estRows,
            chars: estChars.toLocaleString(),
          })}
          {billingHint && <Info className="h-3 w-3" />}
        </span>
      )}
      {!hasResults ? (
        // 未合成：仅「开始配音」
        <Button size="sm" onClick={() => start()} disabled={!canStart}>
          <Play className="mr-1 h-3.5 w-3.5" />
          {t('startDubbing')}
        </Button>
      ) : allDone ? (
        // 全部完成：重跑（副）+ 导出（主）
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => start({ force: true })}
            disabled={!canStart}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            {t('redubAll')}
          </Button>
          {exportButton('default')}
        </>
      ) : (
        // 部分完成：继续合成（主）+ 导出（副）
        <>
          <Button size="sm" onClick={() => start()} disabled={!canStart}>
            <Play className="mr-1 h-3.5 w-3.5" />
            {t('resumeDubbing')}
          </Button>
          {exportButton('outline')}
        </>
      )}
    </div>
  );
}

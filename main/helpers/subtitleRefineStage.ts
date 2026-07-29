/**
 * AI 字幕精修阶段编排（openspec: add-ai-subtitle-refine D1/D9/D10）。
 *
 * 位置：转写完成之后、简繁归一/中文去标点与翻译之前（fileProcessor 的 ASR 路径内），
 * 仅对本轮 ASR 转写产物执行——内封提取、配对字幕、用户导入字幕不重断句。
 *
 * 两遍串行：遍 A 语义断句（segmentationRunner）→ 遍 B 文本校正（correctionRunner）。
 * 阶段级兜底：服务商不可解析 / 任何异常 → 字幕保持进入本阶段前的形态，任务不失败；
 * 取消回退阶段状态并按任务取消语义上抛。
 */

import fs from 'fs';
import { logMessage, store } from './storeManager';
import { formatSrtContent } from './fileUtils';
import { parseSubtitleCues } from './subtitleFormats';
import { formatTime, type TokenTriple } from './subtitleSegmentation';
import {
  TaskCancelledError,
  getTaskContext,
  isTaskCancelledError,
} from './taskContext';
import { readWordTimelineSidecar } from './wordTimelineSidecar';
import { collectSuspectWords } from './subtitleRefine/wordSources';
import { runAiSegmentation } from './subtitleRefine/segmentationRunner';
import { runAiCorrection } from './subtitleRefine/correctionRunner';
import type { Provider } from '../translate/types';
import type { IFiles } from '../../types';

/** 精修服务商字段的「跟随翻译服务」哨兵值（D9 默认）。 */
export const FOLLOW_TRANSLATION_PROVIDER = 'follow-translation';

export interface RefineStageConfig {
  segmentation: boolean;
  correction: boolean;
}

/**
 * 任务级精修开关（D9）：`aiSegmentation` / `aiCorrection` 独立布尔字段，
 * 缺省即关闭——旧配置快照 / 旧 Recipe 无这些键，行为与现版本一致。
 * （UI 的「字幕断句方式」第四档写入 aiSegmentation=true，宽度语义沿用 maxSubtitleChars。）
 */
export function getRefineStageConfig(
  formData?: Record<string, unknown>,
): RefineStageConfig {
  return {
    segmentation: formData?.aiSegmentation === true,
    correction: formData?.aiCorrection === true,
  };
}

export interface RefineProviderResolution {
  provider: Provider | null;
  source: 'follow' | 'explicit';
  reason?: string;
}

/**
 * 精修服务商解析（D9）：
 *  - 缺省 / 'follow-translation' → 跟随任务翻译服务商（须 AI 类型，运行时解析）；
 *  - 显式 id → 对应已配置 AI 服务商；
 *  - 不可解析（翻译非 AI / 未选翻译 / id 不存在）→ null；阶段结算为 done（降级）并写入
 *    refineSubtitleError；向导与旧任务页启动前校验兜底正常路径。
 */
export function resolveRefineProvider(
  formData?: Record<string, unknown>,
): RefineProviderResolution {
  const providers: Provider[] = store.get('translationProviders') || [];
  const setting = String(
    formData?.refineProvider || FOLLOW_TRANSLATION_PROVIDER,
  );
  if (setting === FOLLOW_TRANSLATION_PROVIDER) {
    const translateId = String(formData?.translateProvider ?? '-1');
    const provider = providers.find((p) => p.id === translateId);
    if (!provider) {
      return {
        provider: null,
        source: 'follow',
        reason: '任务未选择翻译服务商，「跟随翻译服务」无法解析',
      };
    }
    if (!provider.isAi) {
      return {
        provider: null,
        source: 'follow',
        reason: `翻译服务商 ${provider.name} 非 AI 类型，「跟随翻译服务」无法解析`,
      };
    }
    return { provider, source: 'follow' };
  }
  const provider = providers.find((p) => p.id === setting);
  if (!provider) {
    return {
      provider: null,
      source: 'explicit',
      reason: `精修服务商 ${setting} 不存在（可能已被删除）`,
    };
  }
  if (!provider.isAi) {
    return {
      provider: null,
      source: 'explicit',
      reason: `精修服务商 ${provider.name} 非 AI 类型`,
    };
  }
  return { provider, source: 'explicit' };
}

/**
 * resume / 跳过字幕段时结算精修阶段态：SRT 已含首轮精修产物（或本路径本就不跑精修），
 * 但 processFile 开头会清掉 refineSubtitle；若不回写 done，阶段格会永久 pending、
 * isFileDone 永远为 false。
 */
export function settleSkippedRefineStage(
  event: { sender: { send: (channel: string, ...args: unknown[]) => void } },
  file: IFiles,
  formData?: Record<string, unknown>,
): void {
  const cfg = getRefineStageConfig(formData);
  if (!cfg.segmentation && !cfg.correction) return;
  (file as any).refineSubtitle = 'done';
  event.sender.send('taskFileChange', { ...file, refineSubtitle: 'done' });
  event.sender.send('taskProgressChange', file, 'refineSubtitle', 100);
}

export async function runSubtitleRefineStage(
  event: { sender: { send: (channel: string, ...args: unknown[]) => void } },
  file: IFiles,
  formData?: Record<string, unknown>,
): Promise<void> {
  const cfg = getRefineStageConfig(formData);
  if (!cfg.segmentation && !cfg.correction) return;
  if (!file.srtFile || !fs.existsSync(file.srtFile)) return;
  const signal = getTaskContext()?.signal;

  const sendState = (state: string) => {
    (file as any).refineSubtitle = state;
    event.sender.send('taskFileChange', { ...file, refineSubtitle: state });
  };
  const sendProgress = (pct: number) => {
    event.sender.send(
      'taskProgressChange',
      file,
      'refineSubtitle',
      Math.max(0, Math.min(100, Math.round(pct))),
    );
  };
  const sendDegradedDone = (reason: string) => {
    (file as any).refineSubtitleError = reason;
    sendProgress(100);
    // 非致命降级：任务继续；用 done + error 文案让 UI 可见，不阻断 isFileDone。
    sendState('done');
  };

  const resolution = resolveRefineProvider(formData);
  if (!resolution.provider) {
    logMessage(
      `refine stage skipped (degraded): ${resolution.reason}`,
      'warning',
    );
    sendDegradedDone(resolution.reason || 'refine provider unresolved');
    return;
  }
  const provider = resolution.provider;
  logMessage(
    `refine provider resolved: ${provider.name} (${
      resolution.source === 'follow' ? '跟随翻译服务' : '显式指定'
    })`,
    'info',
  );

  try {
    delete (file as any).refineSubtitleError;
    sendState('loading');
    sendProgress(0);

    const content = await fs.promises.readFile(file.srtFile, 'utf-8');
    // 内部恒为 SRT（交付格式转换在流程末尾才发生）；多行 cue 折叠为单行处理。
    let cues: TokenTriple[] = parseSubtitleCues(content, 'srt').map(
      (cue): TokenTriple => [
        formatTime(cue.startMs / 1000),
        formatTime(cue.endMs / 1000),
        cue.text.replace(/\s*\n+\s*/g, ' ').trim(),
      ],
    );
    if (cues.length === 0) {
      sendProgress(100);
      sendState('done');
      return;
    }
    const inputCount = cues.length;

    const sidecar = readWordTimelineSidecar(file.wordTimelineFile);
    const words = sidecar?.words ?? null;
    const segShare = cfg.segmentation && cfg.correction ? 70 : 100;

    if (cfg.segmentation) {
      const outcome = await runAiSegmentation({
        cues,
        words,
        formData: formData ?? {},
        provider,
        signal,
        onProgress: (done, total) =>
          sendProgress((done / Math.max(1, total)) * segShare),
      });
      cues = outcome.cues;
      sendProgress(segShare);
    }

    if (cfg.correction) {
      const base = cfg.segmentation ? segShare : 0;
      const beforeCount = cues.length;
      const outcome = await runAiCorrection({
        cues,
        formData: formData ?? {},
        provider,
        signal,
        suspectWords: collectSuspectWords(words ?? undefined),
        onProgress: (done, total) =>
          sendProgress(base + (done / Math.max(1, total)) * (100 - base)),
      });
      // 不变性断言（spec: ai-subtitle-correction）：校正不得改变条数与时间轴。
      const timesOk = outcome.cues.every(
        (cue, i) => cue?.[0] === cues[i]?.[0] && cue?.[1] === cues[i]?.[1],
      );
      if (outcome.cues.length === beforeCount && timesOk) {
        cues = outcome.cues;
      } else {
        logMessage(
          `AI correction invariant violated (count ${beforeCount} -> ${outcome.cues.length}, timesOk=${timesOk}), keeping uncorrected cues`,
          'error',
        );
      }
    }

    await fs.promises.writeFile(file.srtFile, formatSrtContent(cues), 'utf-8');
    sendProgress(100);
    sendState('done');
    logMessage(
      `refine stage done: ${inputCount} -> ${cues.length} cues (${file.fileName})`,
      'info',
    );
  } catch (error) {
    if (isTaskCancelledError(error) || signal?.aborted) {
      sendState('');
      throw error instanceof TaskCancelledError
        ? error
        : new TaskCancelledError();
    }
    // 阶段级兜底（spec: 整体降级与取消语义）：任何异常等同未开启本阶段，
    // 字幕保持进入本阶段前的形态，任务继续、不失败。
    const message = error instanceof Error ? error.message : String(error);
    logMessage(
      `refine stage failed (degraded, non-fatal): ${message}`,
      'warning',
    );
    sendDegradedDone(message);
  }
}

import fs from 'fs';
import { parseSubtitleCues } from './subtitleFormats';
import { logMessage } from './storeManager';
import { atomicReplaceTextFile } from './atomicFile';
import {
  TaskCancelledError,
  getTaskContext,
  isTaskCancelledError,
} from './taskContext';
import type { IFiles, ManuscriptMatchSummary } from '../../types';
import {
  ManuscriptFileError,
  getManuscriptConfig,
  matchManuscriptToCues,
  readManuscriptFile,
  replaceMatchedSrtCueTexts,
} from './manuscriptMatching';

interface TaskEvent {
  sender: { send: (channel: string, ...args: unknown[]) => void };
}

function toSummary(
  manuscriptName: string,
  totalCues: number,
  replacedCues: number,
  matchedGroups: number,
  averageConfidence: number,
): ManuscriptMatchSummary {
  return {
    manuscriptName,
    totalCues,
    replacedCues,
    matchedGroups,
    averageConfidence,
  };
}

function sendStageState(
  event: TaskEvent,
  file: IFiles,
  state: '' | 'loading' | 'done',
): void {
  file.manuscriptMatch = state;
  event.sender.send('taskFileChange', { ...file, manuscriptMatch: state });
}

function sendProgress(event: TaskEvent, file: IFiles, progress: number): void {
  event.sender.send(
    'taskProgressChange',
    file,
    'manuscriptMatch',
    Math.max(0, Math.min(100, Math.round(progress))),
  );
}

/**
 * 续跑复用已经落盘的字幕时只回放完成态；首次文稿匹配结果已包含在 srtFile 中，
 * 不应重复用可能已变化的外部文稿改写。
 */
export function settleSkippedManuscriptMatchStage(
  event: TaskEvent,
  file: IFiles,
  formData?: Record<string, unknown>,
): void {
  if (!getManuscriptConfig(formData)) return;
  sendProgress(event, file, 100);
  sendStageState(event, file, 'done');
}

/**
 * ASR 后的非致命文稿匹配阶段。任何文件错误、空文稿、低置信度或写入失败都以
 * done + warning 结算并保留原字幕；只有高置信结果通过全部时间轴不变性检查后才写回。
 */
export async function runManuscriptMatchingStage(
  event: TaskEvent,
  file: IFiles,
  formData?: Record<string, unknown>,
): Promise<void> {
  const config = getManuscriptConfig(formData);
  if (!config || !file.srtFile || !fs.existsSync(file.srtFile)) return;
  const signal = getTaskContext()?.signal;

  const degrade = (
    code: string,
    detail: string,
    summary?: ManuscriptMatchSummary,
  ): void => {
    file.manuscriptMatchError = code;
    file.manuscriptMatchErrorDetail = detail;
    if (summary) file.manuscriptMatchSummary = summary;
    event.sender.send('taskFileChange', { ...file });
    sendProgress(event, file, 100);
    sendStageState(event, file, 'done');
    logMessage(
      `manuscript matching skipped (non-fatal, ${code}): ${detail} (${file.fileName})`,
      'warning',
    );
  };

  try {
    delete file.manuscriptMatchError;
    delete file.manuscriptMatchErrorDetail;
    delete file.manuscriptMatchSummary;
    sendStageState(event, file, 'loading');
    sendProgress(event, file, 0);

    const [originalSrt, manuscript] = await Promise.all([
      fs.promises.readFile(file.srtFile, 'utf-8'),
      readManuscriptFile(config.path, { signal }),
    ]);
    if (signal?.aborted) throw new TaskCancelledError();
    sendProgress(event, file, 25);

    const parsed = parseSubtitleCues(originalSrt, 'srt');
    const originalTimes = parsed.map((cue) => [cue.startMs, cue.endMs]);
    const sourceCues = parsed.map((cue) => ({
      startMs: cue.startMs,
      endMs: cue.endMs,
      // Comparable normalization ignores whitespace; retain the exact text so
      // an unmatched cue can remain byte-for-byte untouched in the source SRT.
      text: cue.text,
    }));
    if (sourceCues.length === 0) {
      degrade(
        'noCues',
        'source subtitle has no cues',
        toSummary(manuscript.name, 0, 0, 0, 0),
      );
      return;
    }

    const outcome = await matchManuscriptToCues(sourceCues, manuscript.text, {
      signal,
      manuscriptUnits: manuscript.units,
    });
    const summary = toSummary(
      manuscript.name,
      outcome.totalCues,
      outcome.replacedCues,
      outcome.matchedGroups,
      outcome.averageConfidence,
    );
    file.manuscriptMatchSummary = summary;
    sendProgress(event, file, 80);
    if (signal?.aborted) throw new TaskCancelledError();

    if (outcome.replacedCues === 0) {
      degrade('noMatch', 'no high-confidence manuscript matches', summary);
      return;
    }
    const timesUnchanged = outcome.cues.every(
      (cue, index) =>
        cue.startMs === originalTimes[index]?.[0] &&
        cue.endMs === originalTimes[index]?.[1],
    );
    if (outcome.cues.length !== parsed.length || !timesUnchanged) {
      degrade(
        'timeline',
        'timeline invariant violated; original ASR kept',
        summary,
      );
      return;
    }

    const replacements = new Map<number, string>();
    for (const match of outcome.matches) {
      match.replacementTexts.forEach((replacement, offset) => {
        replacements.set(match.cueStart + offset, replacement);
      });
    }
    const output = replaceMatchedSrtCueTexts(originalSrt, replacements);
    const writtenCues = parseSubtitleCues(output, 'srt');
    const writtenTimelineUnchanged =
      writtenCues.length === parsed.length &&
      writtenCues.every(
        (cue, index) =>
          cue.startMs === originalTimes[index]?.[0] &&
          cue.endMs === originalTimes[index]?.[1],
      );
    if (
      replacements.size !== outcome.replacedCues ||
      !writtenTimelineUnchanged
    ) {
      degrade(
        'timeline',
        'safe SRT text replacement validation failed; original ASR kept',
        summary,
      );
      return;
    }

    // Temp is flushed and closed before a single same-directory atomic rename.
    // Any failure leaves the existing SRT untouched.
    await atomicReplaceTextFile(file.srtFile, output, { signal });

    event.sender.send('taskFileChange', { ...file });
    sendProgress(event, file, 100);
    sendStageState(event, file, 'done');
    logMessage(
      `manuscript matching done: ${outcome.replacedCues}/${outcome.totalCues} cues, ${outcome.matchedGroups} groups, avg confidence ${outcome.averageConfidence.toFixed(3)} (${file.fileName})`,
      'info',
    );
  } catch (error) {
    if (isTaskCancelledError(error) || signal?.aborted) {
      sendStageState(event, file, '');
      throw error instanceof TaskCancelledError
        ? error
        : new TaskCancelledError();
    }
    const code =
      error instanceof ManuscriptFileError ? error.code : 'processing';
    const detail = error instanceof Error ? error.message : String(error);
    degrade(code, detail);
  }
}

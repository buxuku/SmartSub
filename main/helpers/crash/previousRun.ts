/**
 * 上一次运行是怎么结束的：纯函数，不依赖 electron，所有输入由调用方提供。
 *
 * 判定要保守——只靠“没走完退出流程”会误报：强杀、安装程序关闭应用、断电、
 * 开发时 Ctrl+C 都是这个状态。因此只有同时满足
 *   1) 上次状态文件说 cleanExit=false，且
 *   2) 找到至少一条崩溃证据（上次启动之后出现的新转储、遗留的在途标记、崩溃事件）
 * 才产出给用户的提示；只满足 1) 时只写一行日志。
 */
import path from 'path';
import type {
  PreviousRunEvidenceKind,
  PreviousRunNotice,
} from '../../../types/diagnostics';
import type { CrashContextEntry } from './crashContext';
import type { DumpFile } from './crashDumps';
import type { CrashEvent } from './crashEvents';
import { describeExit, type ExitClassification } from './exitClassifier';
import {
  classifySummaryException,
  type MinidumpSummary,
} from './minidumpSummary';
import type { InFlightMark, RunState } from './runState';

/** 最多解读几份新转储：崩溃循环时转储可能很多，只看最新的几份就够判断。 */
const MAX_SUMMARIZED_DUMPS = 3;

export interface AssessPreviousRunInput {
  /** 启动时读到的上次状态；null = 没有记录（首次运行、文件损坏或被删） */
  previous: RunState | null;
  now: number;
  /** 当前全部转储（新的在前） */
  dumps: DumpFile[];
  /** 只会对“新”转储调用 */
  summarize: (file: string) => MinidumpSummary | null;
  events: CrashEvent[];
  appVersion?: string;
  platform?: string;
  arch?: string;
}

export interface NewDumpEvidence {
  file: string;
  name: string;
  mtimeMs: number;
  summary: MinidumpSummary | null;
  classification: ExitClassification | null;
}

export interface PreviousRunAssessment {
  /** unknown：没有上次的记录；clean：上次走完了退出流程；abnormal：没走完 */
  status: 'unknown' | 'clean' | 'abnormal';
  newDumps: NewDumpEvidence[];
  inFlight: InFlightMark[];
  crashEvents: CrashEvent[];
  evidence: PreviousRunEvidenceKind[];
  /** 仅在 abnormal 且有证据时有值 */
  notice: PreviousRunNotice | null;
  /** 需要追加到 crash-events 的 previous-run 事件（条件同上） */
  event: CrashEvent | null;
  /** 需要写进应用日志的一行（clean / unknown 时为空） */
  log: { level: 'info' | 'warning'; message: string } | null;
}

function fileName(file: string): string {
  return path.basename(file.replace(/\\/g, '/'));
}

function newestMark(marks: InFlightMark[]): InFlightMark | undefined {
  return marks.reduce<InFlightMark | undefined>(
    (best, mark) => (!best || mark.startedAt >= best.startedAt ? mark : best),
    undefined,
  );
}

function markToContext(mark: InFlightMark): CrashContextEntry {
  return {
    engine: mark.engine,
    ...(mark.backend ? { backend: mark.backend } : {}),
    ...(mark.model ? { model: mark.model } : {}),
    ...(mark.phase ? { phase: mark.phase } : {}),
    startedAt: mark.startedAt,
  };
}

function describeEvidence(
  dumps: NewDumpEvidence[],
  marks: InFlightMark[],
  events: CrashEvent[],
): string {
  const parts: string[] = [];
  if (dumps.length) {
    const module = dumps.find((d) => d.summary?.faultModule)?.summary
      ?.faultModule?.name;
    parts.push(
      `dump x${dumps.length}${module ? ` (fault module ${module})` : ''}`,
    );
  }
  if (marks.length) {
    const mark = newestMark(marks);
    const where = mark
      ? [mark.engine, mark.backend].filter(Boolean).join('/')
      : '';
    parts.push(`in-flight x${marks.length}${where ? ` (${where})` : ''}`);
  }
  if (events.length) parts.push(`crash events x${events.length}`);
  return parts.join(', ');
}

export function assessPreviousRun(
  input: AssessPreviousRunInput,
): PreviousRunAssessment {
  const { previous } = input;
  const empty: PreviousRunAssessment = {
    status: previous ? 'clean' : 'unknown',
    newDumps: [],
    inFlight: [],
    crashEvents: [],
    evidence: [],
    notice: null,
    event: null,
    log: null,
  };
  if (!previous || previous.cleanExit) return empty;

  const since = previous.startedAt;
  const newDumps: NewDumpEvidence[] = input.dumps
    .filter((dump) => dump.mtimeMs >= since)
    .slice(0, MAX_SUMMARIZED_DUMPS)
    .map((dump) => {
      const summary = input.summarize(dump.file);
      return {
        file: dump.file,
        name: fileName(dump.file),
        mtimeMs: dump.mtimeMs,
        summary,
        classification: summary ? classifySummaryException(summary) : null,
      };
    });
  const inFlight = previous.inFlight;
  const crashEvents = input.events.filter(
    (event) =>
      event.ts >= since &&
      event.source !== 'previous-run' &&
      event.classification?.isCrash === true,
  );

  const evidence: PreviousRunEvidenceKind[] = [];
  if (newDumps.length) evidence.push('dump');
  if (inFlight.length) evidence.push('in-flight');
  if (crashEvents.length) evidence.push('event');

  const base: PreviousRunAssessment = {
    ...empty,
    status: 'abnormal',
    newDumps,
    inFlight,
    crashEvents,
    evidence,
  };

  if (!evidence.length) {
    return {
      ...base,
      log: {
        level: 'info',
        message:
          'Previous run did not exit cleanly, but no crash evidence was found (a forced quit, an installer or a power loss is the usual cause)',
      },
    };
  }

  const latestEvent = crashEvents[crashEvents.length - 1];
  const dumpWithClass = newDumps.find((d) => d.classification);
  const classification =
    dumpWithClass?.classification ?? latestEvent?.classification ?? undefined;
  const mark = newestMark(inFlight);
  const context: CrashContextEntry[] = mark
    ? [markToContext(mark)]
    : (latestEvent?.context ?? []);
  const where = mark ?? context[0];
  const faultModule = newDumps.find((d) => d.summary?.faultModule)?.summary
    ?.faultModule?.name;
  const at = Math.max(
    since,
    ...newDumps.map((d) => d.mtimeMs),
    ...crashEvents.map((e) => e.ts),
    ...inFlight.map((m) => m.startedAt),
  );

  const detail = `previous run did not exit cleanly; evidence: ${describeEvidence(newDumps, inFlight, crashEvents)}`;
  const event: CrashEvent = {
    ts: input.now,
    source: 'previous-run',
    reason: 'abnormal-exit',
    ...(classification ? { classification } : {}),
    ...(context.length ? { context } : {}),
    detail,
    // 记的是崩溃的那一版，升级之后读到时也不会张冠李戴
    ...((previous.appVersion ?? input.appVersion)
      ? { appVersion: previous.appVersion ?? input.appVersion }
      : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.arch ? { arch: input.arch } : {}),
  };

  const notice: PreviousRunNotice = {
    at,
    evidence,
    ...(classification
      ? { kind: classification.kind, label: classification.label }
      : {}),
    ...(faultModule ? { faultModule } : {}),
    ...(where?.engine ? { engine: where.engine } : {}),
    ...(where?.backend ? { backend: where.backend } : {}),
  };

  const fault = classification
    ? ` Fault: ${describeExit(classification)}.`
    : '';
  return {
    ...base,
    notice,
    event,
    log: {
      level: 'warning',
      message: `Previous run ended abnormally (${describeEvidence(newDumps, inFlight, crashEvents)}).${fault}`,
    },
  };
}

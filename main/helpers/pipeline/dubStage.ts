/**
 * 流水线配音阶段执行体：字幕生产段完成后，把文件的最终字幕批量配音为完整配音轨。
 *
 * - 文本源：纯译文优先（dubTextSource），按内容 hash 保存不可变快照（
 *   重试时会话恢复只跑失败/未完成行；译文变化 → hash 不匹配 → 自动重建会话）。
 * - 执行：headless 配音会话（sessionId 挂在文件上，工作台可回开检视）→
 *   runDubbingBatch（行进度 → dubbing 阶段进度）→ buildDubTrack 产出配音轨与
 *   （时移发生时的）顺延字幕，路径落文件字段供合成阶段消费。
 * - 互斥：全局 dubStage 闸（本地 TTS 进程池与云端配额都不适合多文件并发），
 *   排队文件的听写/翻译照常并行。
 * - 过长行/失败行阻断成片；工作台显式解决后重试，已完成行保持复用。
 */

import fs from 'fs';
import path from 'path';
import { logMessage } from '../storeManager';
import { ensureTempDir } from '../fileUtils';
import {
  TaskCancelledError,
  getTaskSignal,
  throwIfTaskCancelled,
} from '../taskContext';
import { GroupMutex } from '../engines/transcribeGate';
import { createComposeOutput } from '../compose/composeOutput';
import {
  createDubbingSession,
  deleteDubbingSessionData,
  restoreDubbingSession,
  cancelDubbing,
  runDubbingBatch,
  buildDubTrack,
  flushDubbingSession,
  type DubbingSession,
} from '../dubbing/dubbingProcessor';
import { hashSubtitleContent } from '../dubbing/sessionStore';
import { dubbingSessionOwnership } from '../dubbing/sessionOwnership';
import { readConfigDraft, readCueDraft } from '../dubbing/configDraftStore';
import {
  serializeSubtitleCues,
  parseSubtitleCues,
  detectSubtitleFormatFromContent,
} from '../subtitleFormats';
import { readProofreadDataFile } from '../proofreadData';
import {
  pickDubTextSource,
  cuesFromSidecarTargets,
  pipelineDubLanguage,
} from './dubTextSource';
import type { IFiles, IFormData, PipelineDubConfig } from '../../../types';
import {
  withDubbingGlobalSpeakerFallback,
  type DubbingConfig,
} from '../../../types/dubbing';

/** 配音阶段全局互斥（跨任务/跨文件串行；行级并发由引擎配置决定） */
const dubStageMutex = new GroupMutex();

const STAGE_KEY = 'dubbing';

function reserveSession(sessionId: string): () => void {
  const release = dubbingSessionOwnership.acquirePipeline(sessionId);
  try {
    if (readConfigDraft(sessionId) !== null || readCueDraft(sessionId) !== null)
      throw new Error(
        'Dubbing project has unconfirmed edits; restore or discard them in the dubbing workbench before retrying',
      );
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function emitStatus(event: any, file: IFiles, status: string) {
  if (status === 'loading' || status === 'done') file.dubbingError = '';
  event.sender.send('taskFileChange', { ...file, [STAGE_KEY]: status });
}

function emitError(event: any, file: IFiles, message: string) {
  event.sender.send('taskStatusChange', file, STAGE_KEY, 'error');
  event.sender.send('taskErrorChange', file, STAGE_KEY, message);
}

/**
 * 按内容保留不可变文本快照。上游改变时新建会话，不删除旧修订和 WAV。
 */
async function materializeDubSubtitle(
  file: IFiles,
  formData: IFormData & { translateProvider?: string },
): Promise<string> {
  const source = pickDubTextSource(file, formData, (p) => fs.existsSync(p));
  const outDir = path.join(ensureTempDir(), 'pipeline-dub');
  fs.mkdirSync(outDir, { recursive: true });
  let content: string;
  if (source.type === 'ready') {
    const raw = fs.readFileSync(source.path, 'utf-8');
    content = serializeSubtitleCues(
      parseSubtitleCues(raw, detectSubtitleFormatFromContent(source.path, raw)),
      'srt',
    );
  } else if (source.type === 'sidecar') {
    const data = await readProofreadDataFile(source.sidecarPath);
    const cues =
      source.content === 'source'
        ? data.cues.map((cue) => ({
            startMs: cue.startMs,
            endMs: cue.endMs,
            text: cue.source.trim(),
          }))
        : cuesFromSidecarTargets(data?.cues ?? []);
    if (!cues.length || cues.every((c) => !c.text)) {
      throw new Error('配音文本源为空：校对数据中没有可用译文');
    }
    content = serializeSubtitleCues(cues, 'srt');
    logMessage(`dub stage: rebuilt pure translation from sidecar`, 'info');
  } else {
    throw new Error(
      source.reason === 'bilingual-unresolvable'
        ? '无法获取纯译文文本（仅有双语交付物且校对数据缺失），请重跑翻译后再试'
        : '找不到可配音的字幕文件',
    );
  }
  const outPath = path.join(
    outDir,
    `${file.uuid}-${hashSubtitleContent(content)}.srt`,
  );
  try {
    fs.writeFileSync(outPath, content, { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      fs.readFileSync(outPath, 'utf-8') !== content
    )
      throw error;
  }
  return outPath;
}

/**
 * 交付字幕保持原始展示时长和双语源文，只替换明确匹配的旧配音文本。
 * 不明确的行结构/时间轴拒绝合成，避免把旧译文或错误对应静默写入成片。
 */
function resolveDubSubtitle(file: IFiles, session: DubbingSession) {
  const original = parseSubtitleCues(
    fs.readFileSync(session.subtitlePath, 'utf-8'),
    'srt',
  );
  const candidates = [
    file.tempFinalSubtitleFile,
    file.translatedSrtFile,
    file.tempSrtFile,
    file.srtFile,
  ];
  const mode = session.cues.some(
    (cue, index) => cue.text !== original[index]?.text,
  )
    ? ('always' as const)
    : ('ifShifted' as const);
  for (const candidate of candidates) {
    if (!candidate || /\.txt$/i.test(candidate) || !fs.existsSync(candidate)) {
      continue;
    }
    const content = fs.readFileSync(candidate, 'utf-8');
    const cues = parseSubtitleCues(
      content,
      detectSubtitleFormatFromContent(candidate, content),
    );
    if (
      cues.length !== session.cues.length ||
      original.length !== session.cues.length
    )
      throw new Error('交付字幕与配音行数不一致，请重新校对字幕后再导出');
    const displayTextByIndex = new Map(
      cues.map((cue, index) => {
        const base = original[index];
        const current = session.cues[index];
        if (cue.startMs !== base.startMs || cue.endMs !== base.endMs)
          throw new Error('交付字幕与配音时间轴不一致，请重新校对字幕后再导出');
        if (current.text === base.text) return [current.index, cue.text];
        // Replace a unique block of translation lines, retaining source lines.
        const lines = cue.text.split('\n').map((line) => line.trim());
        const oldLines = base.text.split('\n').map((line) => line.trim());
        const matches = lines.flatMap((_, offset) =>
          oldLines.every((line, i) => lines[offset + i] === line)
            ? [offset]
            : [],
        );
        if (matches.length !== 1)
          throw new Error(
            `第 ${index + 1} 行无法安全更新双语字幕，请在校对页统一文本后重试`,
          );
        lines.splice(matches[0], oldLines.length, current.text);
        return [current.index, lines.join('\n')];
      }),
    );
    return { mode, preserveOriginalWindows: true, displayTextByIndex };
  }
  return { mode, preserveOriginalWindows: true };
}

/**
 * 无合成阶段的任务：配音轨即最终交付物，导出到输入文件旁 `<名>-dubbed.wav`
 * （会话目录里的 wav 对用户不可见）。每次发布保留已有交付物。
 */
async function exportDubbedAudioDeliverable(
  file: IFiles,
  trackPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const dir = path.dirname(file.filePath);
  const stem = path.basename(file.filePath, path.extname(file.filePath));
  const output = createComposeOutput(path.join(dir, `${stem}-dubbed.wav`), [
    file.filePath,
    trackPath,
  ]);
  try {
    await fs.promises.copyFile(trackPath, output.staged);
    const target = await output.publish(signal ?? new AbortController().signal);
    file.dubbedAudioPath = target;
    logMessage(`dubbed audio deliverable: ${target}`, 'info');
  } finally {
    output.cleanup();
  }
}

/** 获取或恢复该文件的配音会话（hash 一致恢复已完成行；不一致/缺失重建） */
async function ensureDubSession(
  file: IFiles,
  subtitlePath: string,
  isMediaInput: boolean,
  subtitleLanguage?: string,
): Promise<DubbingSession> {
  if (file.dubbingSessionId) {
    const restored = restoreDubbingSession(file.dubbingSessionId);
    if (restored.kind === 'ok' && restored.session.running)
      throw new Error('配音会话正在使用中，请等待工作台操作完成后重试');
    if (
      restored.kind === 'ok' &&
      restored.session.subtitleHash ===
        hashSubtitleContent(fs.readFileSync(subtitlePath, 'utf-8'))
    ) {
      restored.session.subtitleLanguage =
        subtitleLanguage ?? restored.session.subtitleLanguage;
      logMessage(
        `dub stage: session restored (${restored.session.cues.filter((c) => c.wavPath).length} cues reusable)`,
        'info',
      );
      return restored.session;
    }
    // Keep the previous revision and audio even if replacement creation fails.
  }
  return createDubbingSession(
    subtitlePath,
    isMediaInput ? file.filePath : undefined,
    file.proofreadDataFile,
    subtitleLanguage,
  );
}

function toDubbingConfig(dub: PipelineDubConfig): DubbingConfig {
  return {
    engine: dub.engine,
    language: dub.language,
    voice: dub.voice,
    globalSpeed: dub.globalSpeed || 1,
    cloneQuality: dub.cloneQuality ?? 'standard',
    localConcurrency: dub.localConcurrency ?? 1,
    background: 'mute',
    output: 'audioOnly',
    overflow: dub.overflow ?? 'truncate',
    overlapMode: dub.overlapMode ?? 'mix',
    exportShiftedSubtitle: false,
  };
}

function resolvePipelineConfig(
  session: DubbingSession,
  dub: PipelineDubConfig,
): DubbingConfig {
  const task = toDubbingConfig(dub);
  const config = { ...task, ...session.lastConfig };
  if (session.pipelineConfigSnapshot) {
    for (const key of Object.keys(task) as Array<keyof DubbingConfig>) {
      if (
        JSON.stringify(task[key]) !==
        JSON.stringify(session.pipelineConfigSnapshot[key])
      )
        Object.assign(config, { [key]: task[key] });
    }
  }
  session.pipelineConfigSnapshot = task;
  session.lastConfig = config;
  flushDubbingSession(session);
  return config;
}

/**
 * The automatic pipeline has no role picker. Its configured global voice is an
 * explicit fallback for previously unmapped roles; real merge conflicts remain
 * unresolved so the normal batch guard still stops and asks for a decision.
 */
function applyHeadlessSpeakerVoiceFallback(session: DubbingSession): void {
  const conflictedSpeakerIds = new Set(
    Object.entries(session.speakerVoiceConflicts)
      .filter(([, voices]) => voices.length > 1)
      .map(([id]) => Number(id)),
  );
  session.speakerVoiceMap = withDubbingGlobalSpeakerFallback(
    session.speakers,
    session.speakerVoiceMap,
    conflictedSpeakerIds,
  );
}

/**
 * 配音阶段已完成的续跑路径：跳过批量合成，但**总是**按会话当前行状态重建
 * 配音轨与顺延字幕——配音确认检查点里的行级修改（重生成/换音色/借空白）
 * 由此进入成片。会话不可恢复时退回完整配音阶段。
 */
export async function rebuildDubTrackForFile(
  event: any,
  file: IFiles,
  formData: IFormData & { translateProvider?: string },
): Promise<void> {
  let release = () => {};
  try {
    release = file.dubbingSessionId
      ? reserveSession(file.dubbingSessionId)
      : () => {};
    await rebuildReservedDubTrack(event, file, formData, release);
  } catch (error) {
    if (!(error instanceof TaskCancelledError) && !getTaskSignal()?.aborted)
      emitError(
        event,
        file,
        error instanceof Error ? error.message : String(error),
      );
    throw error;
  } finally {
    release();
  }
}

async function rebuildReservedDubTrack(
  event: any,
  file: IFiles,
  formData: IFormData & { translateProvider?: string },
  release: () => void,
): Promise<void> {
  const dub = formData.dub!;
  const subtitlePath = await materializeDubSubtitle(file, formData);
  const restored = file.dubbingSessionId
    ? restoreDubbingSession(file.dubbingSessionId)
    : ({ kind: 'missing' } as const);
  if (
    restored.kind !== 'ok' ||
    restored.session.subtitleHash !==
      hashSubtitleContent(fs.readFileSync(subtitlePath, 'utf-8'))
  ) {
    logMessage(
      `dub track rebuild: session unavailable (${restored.kind}), rerun dub stage`,
      'warning',
    );
    release();
    await runDubStage(event, file, formData);
    return;
  }
  const session = restored.session;
  if (session.running) throw new Error('配音会话正在使用中，请稍后重试');
  session.subtitleLanguage =
    pipelineDubLanguage(formData) ?? session.subtitleLanguage;
  const signal = getTaskSignal();
  emitStatus(event, file, 'loading');
  try {
    throwIfTaskCancelled();
    const config = resolvePipelineConfig(session, dub);
    const track = await buildDubTrack(session, {
      // Review workbench settings are authoritative after a completed stage.
      config,
      overflow: config.overflow,
      overlapMode: config.overlapMode,
      signal,
      shiftedSubtitle: resolveDubSubtitle(file, session),
    });
    flushDubbingSession(session);
    file.dubbedTrackPath = track.trackPath;
    file.shiftedSubtitlePath = track.shiftedSubtitlePath;
    if (!formData.compose) {
      await exportDubbedAudioDeliverable(file, track.trackPath, signal);
    }
    event.sender.send('taskProgressChange', file, STAGE_KEY, 100);
    emitStatus(event, file, 'done');
    logMessage(`dub track rebuilt for ${file.fileName}`, 'info');
  } catch (error) {
    if (error instanceof TaskCancelledError || signal?.aborted) {
      event.sender.send('taskFileChange', { ...file, [STAGE_KEY]: '' });
      throw new TaskCancelledError();
    }
    const message = error instanceof Error ? error.message : String(error);
    logMessage(`dub track rebuild error: ${message}`, 'error');
    emitError(event, file, message);
    throw error;
  }
}

/**
 * 执行配音阶段。成功回填 file.dubbedTrackPath / shiftedSubtitlePath /
 * dubbingSessionId；失败置阶段 error 并抛出（中断该文件后续阶段）。
 */
export async function runDubStage(
  event: any,
  file: IFiles,
  formData: IFormData & { translateProvider?: string },
): Promise<void> {
  const dub = formData.dub!;
  const isMediaInput = ![
    '.srt',
    '.vtt',
    '.ass',
    '.ssa',
    '.lrc',
    '.txt',
  ].includes(file.fileExtension);

  emitStatus(event, file, 'loading');
  event.sender.send('taskProgressChange', file, STAGE_KEY, 0);

  const signal = getTaskSignal();
  let release: (() => void) | null = null;
  let session: DubbingSession | null = null;
  let batchAbort: AbortController | null = null;
  const reservations: Array<() => void> = [];
  const onAbort = () => {
    // Never cancel a later workbench operation after this batch has finished.
    if (session && batchAbort && session.abort === batchAbort)
      cancelDubbing(session);
  };

  try {
    throwIfTaskCancelled();
    const subtitlePath = await materializeDubSubtitle(file, formData);

    // 全局互斥：等待期间阶段保持 loading + 0%（排队原因入日志）
    logMessage(`dub stage: waiting for slot (${file.fileName})`, 'info');
    release = await dubStageMutex.acquire(signal);
    throwIfTaskCancelled();

    if (file.dubbingSessionId)
      reservations.push(reserveSession(file.dubbingSessionId));
    session = await ensureDubSession(
      file,
      subtitlePath,
      isMediaInput,
      pipelineDubLanguage(formData),
    );
    if (session.id !== file.dubbingSessionId)
      reservations.push(reserveSession(session.id));
    const previousSessionId = file.dubbingSessionId;
    file.dubbingSessionId = session.id;
    try {
      event.sender.send('taskFileChange', { ...file, [STAGE_KEY]: 'loading' });
      session.pendingTaskLink = false;
    } catch (error) {
      file.dubbingSessionId = previousSessionId;
      if (session.id !== previousSessionId)
        deleteDubbingSessionData(session.id);
      throw error;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    const config = resolvePipelineConfig(session, dub);
    applyHeadlessSpeakerVoiceFallback(session);
    const batch = runDubbingBatch(session, config, (e) => {
      event.sender.send('taskProgressChange', file, STAGE_KEY, e.percent);
    });
    batchAbort = session.abort;
    const result = await batch;
    batchAbort = null;

    if (result.cancelled || signal?.aborted) {
      throw new TaskCancelledError();
    }
    if (result.failedIndexes.length > 0) {
      throw new Error(
        `配音有 ${result.failedIndexes.length} 行合成失败，可重试（已完成行会跳过）`,
      );
    }

    // Snapshot reviewed audio and display text for the downstream compose job.
    const track = await buildDubTrack(session, {
      config,
      overflow: config.overflow,
      overlapMode: config.overlapMode,
      signal,
      shiftedSubtitle: resolveDubSubtitle(file, session),
    });
    flushDubbingSession(session);

    file.dubbedTrackPath = track.trackPath;
    file.shiftedSubtitlePath = track.shiftedSubtitlePath;
    if (!formData.compose) {
      await exportDubbedAudioDeliverable(file, track.trackPath, signal);
    }
    event.sender.send('taskProgressChange', file, STAGE_KEY, 100);
    emitStatus(event, file, 'done');
    logMessage(
      `dub stage done: ${file.fileName} (track=${track.trackPath}, shifted=${track.shiftedSubtitlePath ?? 'none'})`,
      'info',
    );
  } catch (error) {
    if (error instanceof TaskCancelledError || signal?.aborted) {
      // 取消：阶段回退待处理（与其余阶段的取消语义一致）
      event.sender.send('taskFileChange', {
        ...file,
        [STAGE_KEY]: '',
      });
      throw new TaskCancelledError();
    }
    const message = error instanceof Error ? error.message : String(error);
    logMessage(`dub stage error (${file.fileName}): ${message}`, 'error');
    emitError(event, file, message);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reservations.reverse().forEach((release) => release());
    release?.();
  }
}

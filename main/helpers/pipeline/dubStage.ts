/**
 * 流水线配音阶段执行体：字幕生产段完成后，把文件的最终字幕批量配音为完整配音轨。
 *
 * - 文本源：纯译文优先（dubTextSource），统一拷贝到确定性路径（内容 hash 稳定，
 *   重试时会话恢复只跑失败/未完成行；译文变化 → hash 不匹配 → 自动重建会话）。
 * - 执行：headless 配音会话（sessionId 挂在文件上，工作台可回开检视）→
 *   runDubbingBatch（行进度 → dubbing 阶段进度）→ buildDubTrack 产出配音轨与
 *   （时移发生时的）顺延字幕，路径落文件字段供合成阶段消费。
 * - 互斥：全局 dubStage 闸（本地 TTS 进程池与云端配额都不适合多文件并发），
 *   排队文件的听写/翻译照常并行。
 * - 全自动：过长行由 buildDubTrack 按 overflow 兜底；批量结束仍有失败行 →
 *   阶段 error（重试续跑）。
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
import {
  createDubbingSession,
  restoreDubbingSession,
  deleteDubbingSessionData,
  cancelDubbing,
  runDubbingBatch,
  buildDubTrack,
  flushDubbingSession,
  type DubbingSession,
} from '../dubbing/dubbingProcessor';
import {
  serializeSubtitleCues,
  parseSubtitleCues,
  detectSubtitleFormatFromContent,
} from '../subtitleFormats';
import { readProofreadDataFile } from '../proofreadData';
import { pickDubTextSource, cuesFromSidecarTargets } from './dubTextSource';
import type { IFiles, IFormData, PipelineDubConfig } from '../../../types';
import type { DubbingConfig } from '../../../types/dubbing';

/** 配音阶段全局互斥（跨任务/跨文件串行；行级并发由引擎配置决定） */
const dubStageMutex = new GroupMutex();

const STAGE_KEY = 'dubbing';

function emitStatus(event: any, file: IFiles, status: string) {
  event.sender.send('taskFileChange', { ...file, [STAGE_KEY]: status });
}

function emitError(event: any, file: IFiles, message: string) {
  event.sender.send('taskStatusChange', file, STAGE_KEY, 'error');
  event.sender.send('taskErrorChange', file, STAGE_KEY, message);
}

/**
 * 解析文本源并落到确定性路径（<tmp>/pipeline-dub/<uuid>.srt）。
 * 内容不变 → 会话 hash 稳定 → 重试恢复；内容变化 → 自动判 stale 重建。
 */
async function materializeDubSubtitle(
  file: IFiles,
  formData: IFormData & { translateProvider?: string },
): Promise<string> {
  const source = pickDubTextSource(file, formData, (p) => fs.existsSync(p));
  const outDir = path.join(ensureTempDir(), 'pipeline-dub');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${file.uuid}.srt`);

  if (source.type === 'ready') {
    fs.copyFileSync(source.path, outPath);
    return outPath;
  }
  if (source.type === 'sidecar') {
    const data = await readProofreadDataFile(source.sidecarPath);
    const cues = cuesFromSidecarTargets(data?.cues ?? []);
    if (!cues.length || cues.every((c) => !c.text)) {
      throw new Error('配音文本源为空：校对数据中没有可用译文');
    }
    fs.writeFileSync(outPath, serializeSubtitleCues(cues, 'srt'), 'utf-8');
    logMessage(`dub stage: rebuilt pure translation from sidecar`, 'info');
    return outPath;
  }
  throw new Error(
    source.reason === 'bilingual-unresolvable'
      ? '无法获取纯译文文本（仅有双语交付物且校对数据缺失），请重跑翻译后再试'
      : '找不到可配音的字幕文件',
  );
}

/**
 * 顺延字幕的展示文本覆盖：合成阶段无时移时烧的是交付字幕（双语选双语），
 * 时移发生时烧顺延字幕——其文本若用配音源（纯译文）会丢掉用户选择的双语内容。
 * 这里按合成阶段同样的交付物优先级（译文交付物 → 源字幕 → 临时源字幕）解析
 * 展示文本，与会话 cue 数一致才覆盖；不一致（防御）回退纯译文，时间轴仍正确。
 */
function resolveShiftedDisplayTexts(
  file: IFiles,
  expectedCount: number,
): Map<number, string> | undefined {
  const candidates = [file.translatedSrtFile, file.srtFile, file.tempSrtFile];
  for (const candidate of candidates) {
    if (!candidate || /\.txt$/i.test(candidate) || !fs.existsSync(candidate)) {
      continue;
    }
    try {
      const content = fs.readFileSync(candidate, 'utf-8');
      const cues = parseSubtitleCues(
        content,
        detectSubtitleFormatFromContent(candidate, content),
      );
      if (cues.length !== expectedCount) {
        logMessage(
          `dub stage: shifted subtitle keeps dub text (deliverable cue count ${cues.length} != session ${expectedCount})`,
          'warning',
        );
        return undefined;
      }
      return new Map(cues.map((cue, index) => [index, cue.text]));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 无合成阶段的任务：配音轨即最终交付物，导出到输入文件旁 `<名>-dubbed.wav`
 * （会话目录里的 wav 对用户不可见）。重试/检查点重建时覆写同一路径。
 */
function exportDubbedAudioDeliverable(file: IFiles, trackPath: string): void {
  const existing =
    file.dubbedAudioPath && fs.existsSync(path.dirname(file.dubbedAudioPath))
      ? file.dubbedAudioPath
      : null;
  let target = existing;
  if (!target) {
    const dir = path.dirname(file.filePath);
    const stem = path.basename(file.filePath, path.extname(file.filePath));
    target = path.join(dir, `${stem}-dubbed.wav`);
    let n = 2;
    while (fs.existsSync(target)) {
      target = path.join(dir, `${stem}-dubbed-${n}.wav`);
      n += 1;
    }
  }
  fs.copyFileSync(trackPath, target);
  file.dubbedAudioPath = target;
  logMessage(`dubbed audio deliverable: ${target}`, 'info');
}

/** 获取或恢复该文件的配音会话（hash 一致恢复已完成行；不一致/缺失重建） */
async function ensureDubSession(
  file: IFiles,
  subtitlePath: string,
  isMediaInput: boolean,
): Promise<DubbingSession> {
  if (file.dubbingSessionId) {
    const restored = restoreDubbingSession(file.dubbingSessionId);
    if (restored.kind === 'ok') {
      logMessage(
        `dub stage: session restored (${restored.session.cues.filter((c) => c.wavPath).length} cues reusable)`,
        'info',
      );
      return restored.session;
    }
    // stale（译文已变）/ missing：旧会话数据作废，重建
    deleteDubbingSessionData(file.dubbingSessionId);
  }
  return createDubbingSession(
    subtitlePath,
    isMediaInput ? file.filePath : undefined,
  );
}

function toDubbingConfig(dub: PipelineDubConfig): DubbingConfig {
  return {
    engine: dub.engine,
    voice: dub.voice,
    globalSpeed: dub.globalSpeed || 1,
    cloneQuality: dub.cloneQuality ?? 'standard',
    localConcurrency: dub.localConcurrency ?? 1,
    background: 'mute',
    output: 'audioOnly',
    overflow: dub.overflow ?? 'truncate',
    overlapMode: dub.overlapMode ?? 'shift',
    exportShiftedSubtitle: false,
  };
}

/**
 * 配音阶段已完成的续跑路径：跳过批量合成，但**总是**按会话当前行状态重建
 * 配音轨与顺延字幕——配音确认检查点里的行级修改（重生成/换音色/接受变速）
 * 由此进入成片。会话不可恢复时退回完整配音阶段。
 */
export async function rebuildDubTrackForFile(
  event: any,
  file: IFiles,
  formData: IFormData & { translateProvider?: string },
): Promise<void> {
  const dub = formData.dub!;
  const restored = file.dubbingSessionId
    ? restoreDubbingSession(file.dubbingSessionId)
    : ({ kind: 'missing' } as const);
  if (restored.kind !== 'ok') {
    logMessage(
      `dub track rebuild: session unavailable (${restored.kind}), rerun dub stage`,
      'warning',
    );
    await runDubStage(event, file, formData);
    return;
  }
  const session = restored.session;
  const signal = getTaskSignal();
  emitStatus(event, file, 'loading');
  try {
    throwIfTaskCancelled();
    const track = await buildDubTrack(session, {
      overflow: dub.overflow ?? 'truncate',
      overlapMode: dub.overlapMode ?? 'shift',
      signal,
      shiftedSubtitle: {
        path: path.join(session.workDir, 'dubbed-shifted.srt'),
        mode: 'ifShifted',
        displayTextByIndex: resolveShiftedDisplayTexts(
          file,
          session.cues.length,
        ),
      },
    });
    flushDubbingSession(session);
    file.dubbedTrackPath = track.trackPath;
    file.shiftedSubtitlePath = track.shiftedSubtitlePath;
    if (!formData.compose) {
      exportDubbedAudioDeliverable(file, track.trackPath);
    }
    event.sender.send('taskProgressChange', file, STAGE_KEY, 100);
    event.sender.send('taskFileChange', { ...file, [STAGE_KEY]: 'done' });
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
  const onAbort = () => {
    if (session) cancelDubbing(session);
  };

  try {
    throwIfTaskCancelled();
    const subtitlePath = await materializeDubSubtitle(file, formData);

    // 全局互斥：等待期间阶段保持 loading + 0%（排队原因入日志）
    logMessage(`dub stage: waiting for slot (${file.fileName})`, 'info');
    release = await dubStageMutex.acquire(signal);
    throwIfTaskCancelled();

    session = await ensureDubSession(file, subtitlePath, isMediaInput);
    file.dubbingSessionId = session.id;
    event.sender.send('taskFileChange', { ...file, [STAGE_KEY]: 'loading' });

    signal?.addEventListener('abort', onAbort, { once: true });

    const config = toDubbingConfig(dub);
    const result = await runDubbingBatch(session, config, (e) => {
      event.sender.send('taskProgressChange', file, STAGE_KEY, e.percent);
    });

    if (result.cancelled || signal?.aborted) {
      throw new TaskCancelledError();
    }
    if (result.failedIndexes.length > 0) {
      throw new Error(
        `配音有 ${result.failedIndexes.length} 行合成失败，可重试（已完成行会跳过）`,
      );
    }

    // 构建完整配音轨 + 顺延字幕（仅时移发生时产出；展示文本跟随交付字幕）
    const track = await buildDubTrack(session, {
      overflow: config.overflow,
      overlapMode: config.overlapMode,
      signal,
      shiftedSubtitle: {
        path: path.join(session.workDir, 'dubbed-shifted.srt'),
        mode: 'ifShifted',
        displayTextByIndex: resolveShiftedDisplayTexts(
          file,
          session.cues.length,
        ),
      },
    });
    flushDubbingSession(session);

    file.dubbedTrackPath = track.trackPath;
    file.shiftedSubtitlePath = track.shiftedSubtitlePath;
    if (!formData.compose) {
      exportDubbedAudioDeliverable(file, track.trackPath);
    }
    event.sender.send('taskProgressChange', file, STAGE_KEY, 100);
    event.sender.send('taskFileChange', {
      ...file,
      [STAGE_KEY]: 'done',
    });
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
    release?.();
  }
}

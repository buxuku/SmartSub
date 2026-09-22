import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { parseDubbingCueEdits } from '../../../types/dubbingCueDraft';
import { logMessage } from '../storeManager';
import { ensureTempDir } from '../fileUtils';
import { TaskCancelledError } from '../taskContext';
import {
  getSessionDir,
  assertSessionAvailable,
  hashSubtitleContent,
  persistSessionMeta,
  flushSessionMeta,
  readSessionMeta,
  deleteSessionData,
  resolvePersistedCue,
} from './sessionStore';
import type { DubbingSessionMeta } from '../../../types/dubbing';
import {
  parseSubtitleCues,
  detectSubtitleFormat,
  serializeSubtitleCues,
  type SubtitleCue,
} from '../subtitleFormats';
import { normalizeDubbingSpeechText } from './textNormalization';
import { resolveTtsModelRequestForVoice } from './ttsLanguageRules';
import { detectDubbingLanguage, dubbingSubtitleLanguage } from './language';
import { dubbingInputKey, dubbingInputNeedsUpdate } from './synthesisIdentity';
import {
  resolveTtsLanguage,
  localTtsLanguageError,
  ttsBaseLanguage,
} from '../../../types/ttsLanguage';
import {
  computeSlots,
  estimateDurationMs,
  createCalibration,
  updateCalibration,
  recheckAfterSynthesis,
  buildAlignmentPlan,
  shiftedTimeline,
  type CueSlot,
  type FinalCue,
  type RateCalibration,
} from './alignment';
import {
  wavDurationMs,
  atempoWav,
  fitSpeechWav,
  applySpeakerSettingsWav,
  trimPreviewWav,
  assembleTrack,
  amixWavs,
  encodeMp3,
  probeMediaDurationMs,
} from './audioPipeline';
import { enqueueCompose, cancelComposeJob } from '../compose/composeQueue';
import {
  createComposeOutput,
  type ComposePublicationState,
} from '../compose/composeOutput';
import type {
  AlignmentPlan,
  AlignmentSpeedAction,
  DubbingConfig,
  DubbingCueStatus,
  DubbingEngineSelection,
  DubbingOverflowMode,
  DubbingOverlapMode,
  DubbingProgressEvent,
  DubbingStage,
} from '../../../types/dubbing';
import {
  CLONE_CORRECTIVE_SPEED_MIN,
  CLONE_ZH_RATE_MAX_CPS,
  CLONE_ZH_RATE_TARGET_CPS,
  cjkCharCount,
} from '../../../types/voiceClone';
import {
  getTtsCapabilities,
  resolveTtsRequestIntervalMs,
} from '../../../types/ttsProvider';
import {
  TTS_MODELS,
  type TtsModelId,
  getTtsModelRequest,
  isTtsModelInstalled,
  resolveTtsVoiceSid,
} from '../ttsModelCatalog';
import { getSherpaTtsRuntime } from '../sherpaOnnx/ttsRuntime';
import { getTtsProviderById } from '../ttsProviderManager';
import { synthesizeSegment } from '../../service/tts';
import { getCloudProviderGate } from '../engines/cloudProviderGate';
import { loadDubbingSpeakerMetadata } from './speakerMetadata';
import {
  cueInheritsSpeaker,
  dubbingVoiceNeedsUpdate,
  missingDubbingSpeakerVoiceIds,
  primaryDubbingSpeakerId,
  resolveDubbingVoiceId,
  resolveDubbingSpeakerSettings,
  assertDubbingSpeakerSettings,
  assertDubbingConfig,
  type DubbingSpeakerSettings,
  type DubbingSpeakerSettingsMap,
  type DubbingSpeaker,
  type DubbingSpeakerVoiceMap,
} from '../../../types/dubbing';

// ===========================================================================
// 配音会话与管线编排：解析字幕 → 逐条合成（本地串行 / 云端并发闸）→ 对齐复测
// → 槽位拼接 → 背景音/输出形态。行级进度事件、AbortSignal 取消、单行失败不中断。
// ===========================================================================

/** 会话内单行状态（DubbingCue 的 main 侧超集）。 */
export interface SessionCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  voiceId?: string;
  speakerIds?: number[];
  primarySpeakerId?: number;
  synthesizedVoiceId?: string;
  synthesizedInputKey?: string;
  needsUpdate?: boolean;
  status: DubbingCueStatus;
  overlap: boolean;
  /** 实测最终时长（ms，含一切变速后）。 */
  finalMs?: number;
  originalMeasuredMs?: number;
  borrowedMs?: number;
  /** 对齐层施加的综合额外倍率（不含用户整体语速）。 */
  appliedSpeed?: number;
  wavPath?: string;
  error?: string;
  /** 过长行的所需综合倍率（提示用）。 */
  requiredFactor?: number;
  action: AlignmentSpeedAction;
}

export interface DubbingSession {
  pendingTaskLink?: boolean;
  hasSavedTextEdits?: boolean;
  id: string;
  subtitlePath: string;
  /** 字幕内容 hash（会话持久化恢复的合法性依据） */
  subtitleHash: string;
  videoPath?: string;
  mediaDurationMs: number;
  cues: SessionCue[];
  proofreadDataFile?: string;
  speakers: DubbingSpeaker[];
  speakerVoiceMap: DubbingSpeakerVoiceMap;
  speakerSettings?: DubbingSpeakerSettingsMap;
  speakerSettingsConflicts?: Record<string, DubbingSpeakerSettings[]>;
  speakerVoiceConflicts: Record<string, string[]>;
  workDir: string;
  running: boolean;
  abort: AbortController | null;
  calibration: RateCalibration;
  lastConfig?: DubbingConfig;
  pipelineConfigSnapshot?: DubbingConfig;
  subtitleLanguage?: string;
  detectedLanguage?: string;
  workItemId?: string;
  /**
   * 会话数据已被删除（工作项删除联动/确认重建）。
   * 置位后一切落盘操作变为 no-op：批量 finally / 行级节流落盘
   * 不得把已 rmSync 的会话目录重新写回（删除↔flush 竞态防线）。
   */
  disposed?: boolean;
}

const sessions = new Map<string, DubbingSession>();

export function getDubbingSession(id: string): DubbingSession | undefined {
  assertSessionAvailable(id);
  return sessions.get(id);
}

export function resolvedSessionCueVoice(
  session: DubbingSession,
  cue: SessionCue,
  globalVoiceId: string,
): string {
  return resolveDubbingVoiceId(cue, session.speakerVoiceMap, globalVoiceId);
}

export function resolvedDubbingLanguage(
  config: Pick<DubbingConfig, 'engine' | 'language'>,
  voiceId: string,
  context: { subtitleLanguage?: string; detectedLanguage?: string } = {},
): string | undefined {
  let voiceLanguage: string | undefined;
  if (config.engine.kind === 'local') {
    const spec = TTS_MODELS[config.engine.modelId as TtsModelId];
    if (spec?.cloneOnly) {
      const { getClonedVoiceById } =
        require('../voiceClone/voiceCloneManager') as typeof import('../voiceClone/voiceCloneManager');
      voiceLanguage = getClonedVoiceById(voiceId)?.language;
    } else {
      voiceLanguage =
        spec?.voices.find((v) => v.id === voiceId)?.lang ??
        spec?.voices.find((v) => v.id === spec.defaultVoiceId)?.lang;
    }
  } else {
    const provider = getTtsProviderById(config.engine.providerId);
    if (provider?.type === 'edge' || provider?.type === 'azureSpeech') {
      voiceLanguage = /^([a-z]{2,3}-[A-Za-z]{2,4})-/.exec(voiceId)?.[1];
    }
  }
  return resolveTtsLanguage({
    ...context,
    language: config.language,
    voiceLanguage,
  });
}

/** Recompute from successful artifacts, never from the last attempted batch. */
export function syncDubbingVoiceStaleness(
  session: DubbingSession,
  config: DubbingConfig,
): number {
  session.detectedLanguage =
    detectDubbingLanguage(session.cues.map((c) => c.text).join('\n')) ??
    session.detectedLanguage;
  let count = 0;
  for (const cue of session.cues) {
    if (!cue.wavPath) continue;
    const synthesizedVoiceId =
      cue.synthesizedVoiceId || session.lastConfig?.voice;
    if (!cue.synthesizedVoiceId) cue.synthesizedVoiceId = synthesizedVoiceId;
    const voiceId = resolvedSessionCueVoice(session, cue, config.voice);
    const settings = resolveDubbingSpeakerSettings(
      cue,
      session.speakerSettings,
    );
    const key = dubbingInputKey(
      config,
      voiceId,
      normalizeDubbingSpeechText(cue.text),
      resolvedDubbingLanguage(config, voiceId, session),
      settings,
      { startMs: cue.startMs, endMs: cue.endMs },
    );
    cue.needsUpdate =
      (!cue.synthesizedInputKey &&
        (settings.speed !== 1 || settings.pitch !== 0)) ||
      dubbingInputNeedsUpdate(cue.synthesizedInputKey, key, config) ||
      dubbingVoiceNeedsUpdate(
        cue,
        session.speakerVoiceMap,
        config.voice,
        synthesizedVoiceId,
      );
    if (cue.needsUpdate) count += 1;
  }
  return count;
}

/** 会话 → 持久化元数据（wav 路径折算为相对会话目录的文件名） */
function toSessionMeta(session: DubbingSession): DubbingSessionMeta {
  return {
    version: 1,
    pendingTaskLink: session.pendingTaskLink,
    hasSavedTextEdits: session.hasSavedTextEdits,
    sessionId: session.id,
    subtitlePath: session.subtitlePath,
    subtitleHash: session.subtitleHash,
    videoPath: session.videoPath,
    mediaDurationMs: session.mediaDurationMs,
    updatedAt: Date.now(),
    configSnapshot: session.lastConfig,
    pipelineConfigSnapshot: session.pipelineConfigSnapshot,
    subtitleLanguage: session.subtitleLanguage,
    detectedLanguage: session.detectedLanguage,
    proofreadDataFile: session.proofreadDataFile,
    speakers: session.speakers,
    speakerVoiceMap: session.speakerVoiceMap,
    speakerSettings: session.speakerSettings,
    speakerSettingsConflicts: session.speakerSettingsConflicts,
    speakerVoiceConflicts: session.speakerVoiceConflicts,
    // 校准随会话落盘：半成品会话重开后续行的语速预估不从零开始
    calibration: session.calibration,
    cues: session.cues.map((c) => ({
      index: c.index,
      startMs: c.startMs,
      endMs: c.endMs,
      text: c.text,
      voiceId: c.voiceId,
      speakerIds: c.speakerIds,
      primarySpeakerId: c.primarySpeakerId,
      synthesizedVoiceId: c.synthesizedVoiceId,
      synthesizedInputKey: c.synthesizedInputKey,
      needsUpdate: c.needsUpdate,
      // 中断快照：synthesizing 落盘为 pending（重开后继续合成）
      status: c.status === 'synthesizing' ? 'pending' : c.status,
      overlap: c.overlap,
      finalMs: c.finalMs,
      originalMeasuredMs: c.originalMeasuredMs,
      borrowedMs: c.borrowedMs,
      appliedSpeed: c.appliedSpeed,
      requiredFactor: c.requiredFactor,
      wavFile: c.wavPath ? path.basename(c.wavPath) : undefined,
      error: c.error,
      action: c.action,
    })),
  };
}

/** 行级状态变更后的节流落盘（批量合成中高频调用） */
export function persistDubbingSession(session: DubbingSession): void {
  if (session.disposed) return;
  persistSessionMeta(toSessionMeta(session));
}

/** 关键节点立即落盘（批量结束/导出后/dispose） */
export function flushDubbingSession(session: DubbingSession): void {
  if (session.disposed) return;
  flushSessionMeta(toSessionMeta(session));
}

/** 解析字幕并创建会话（媒体时长经 ffmpeg -i 探测，无视频则 0）。 */
export async function createDubbingSession(
  subtitlePath: string,
  videoPath?: string,
  proofreadDataFile?: string,
  subtitleLanguage?: string,
): Promise<DubbingSession> {
  const content = fs.readFileSync(subtitlePath, 'utf-8');
  const format = detectSubtitleFormat(subtitlePath);
  const parsed = parseSubtitleCues(content, format);
  if (parsed.length === 0) {
    throw new Error('字幕文件为空或无法解析');
  }
  const mediaDurationMs = videoPath ? await probeMediaDurationMs(videoPath) : 0;
  const speakerMetadata = loadDubbingSpeakerMetadata(
    subtitlePath,
    parsed,
    proofreadDataFile,
  );

  const id = randomUUID();
  // 持久会话目录（应用数据目录下）：dispose 不删除，重开可恢复
  const workDir = getSessionDir(id);
  fs.mkdirSync(workDir, { recursive: true });

  const session: DubbingSession = {
    id,
    pendingTaskLink: true,
    subtitlePath,
    subtitleHash: hashSubtitleContent(content),
    subtitleLanguage:
      subtitleLanguage ??
      dubbingSubtitleLanguage(subtitlePath, proofreadDataFile),
    detectedLanguage: detectDubbingLanguage(
      parsed.map((c) => c.text).join('\n'),
    ),
    videoPath,
    mediaDurationMs,
    workDir,
    running: false,
    abort: null,
    calibration: createCalibration(),
    proofreadDataFile: speakerMetadata.proofreadDataFile,
    speakers: speakerMetadata.speakers,
    speakerVoiceMap: {},
    speakerVoiceConflicts: {},
    cues: parsed.map((c: SubtitleCue, index: number) => {
      const assignment = speakerMetadata.assignments[index] || {};
      return {
        index,
        startMs: c.startMs,
        endMs: c.endMs,
        text: c.text.replace(/\n+/g, ' ').trim(),
        ...(Object.prototype.hasOwnProperty.call(assignment, 'speakerIds')
          ? { speakerIds: [...(assignment.speakerIds || [])] }
          : {}),
        ...(assignment.primarySpeakerId
          ? { primarySpeakerId: assignment.primarySpeakerId }
          : {}),
        status: 'pending' as DubbingCueStatus,
        overlap: false,
        action: { type: 'none' as const },
      };
    }),
  };
  // 重叠检测前置到加载期（UI 立即可见告警）。
  const slots = computeSlots(session.cues, {
    mediaDurationMs: mediaDurationMs || undefined,
  });
  for (const slot of slots) {
    if (slot.overlapNext) session.cues[slot.index].overlap = true;
  }
  sessions.set(id, session);
  try {
    flushSessionMeta(toSessionMeta(session), true);
  } catch (error) {
    deleteDubbingSessionData(id);
    throw error;
  }
  return session;
}

/** 会话恢复结果：ok=恢复成功；stale=字幕已变需重建；missing=无可恢复数据 */
export type RestoreSessionResult =
  | { kind: 'ok'; session: DubbingSession }
  | { kind: 'stale'; subtitlePath: string; videoPath?: string }
  | { kind: 'missing' };

/**
 * 按 sessionId 恢复会话：字幕内容 hash 一致才恢复行状态与产物；
 * 单行 wav 缺失仅该行降级待合成。已在内存中的会话直接复用。
 */
export function restoreDubbingSession(
  sessionId: string,
  options?: { cache?: boolean },
): RestoreSessionResult {
  assertSessionAvailable(sessionId);
  const existing = sessions.get(sessionId);
  if (existing) return { kind: 'ok', session: existing };

  const meta = readSessionMeta(sessionId);
  if (!meta) return { kind: 'missing' };
  if (!fs.existsSync(meta.subtitlePath)) {
    return { kind: 'missing' };
  }
  const content = fs.readFileSync(meta.subtitlePath, 'utf-8');
  if (hashSubtitleContent(content) !== meta.subtitleHash) {
    return {
      kind: 'stale',
      subtitlePath: meta.subtitlePath,
      videoPath: meta.videoPath,
    };
  }

  const parsed = parseSubtitleCues(
    content,
    detectSubtitleFormat(meta.subtitlePath),
  );
  const refreshed = loadDubbingSpeakerMetadata(
    meta.subtitlePath,
    parsed,
    meta.proofreadDataFile,
  );
  const hasRefreshedMetadata = Boolean(refreshed.proofreadDataFile);
  const speakerVoiceMap: DubbingSpeakerVoiceMap = {
    ...(meta.speakerVoiceMap || {}),
  };
  const speakerVoiceConflicts: Record<string, string[]> = {
    ...(meta.speakerVoiceConflicts || {}),
  };
  const speakerSettings = { ...meta.speakerSettings };
  const speakerSettingsConflicts = { ...meta.speakerSettingsConflicts };

  // A renamed role keeps the same ID and therefore its mapping. If assignments
  // changed (for example a merge), collect all old candidate voices for the new
  // primary role; one candidate can migrate automatically, conflicting voices
  // require an explicit choice in the workbench.
  if (hasRefreshedMetadata) {
    const activeSpeakerIds = new Set(
      refreshed.speakers.map((speaker) => String(speaker.id)),
    );
    for (const speakerId of Object.keys(speakerVoiceConflicts)) {
      if (!activeSpeakerIds.has(speakerId)) {
        delete speakerVoiceConflicts[speakerId];
      }
    }
    const candidates = new Map<number, Set<string>>();
    for (const speakerId of Object.keys(speakerSettingsConflicts)) {
      if (!activeSpeakerIds.has(speakerId))
        delete speakerSettingsConflicts[speakerId];
    }
    const settingsCandidates = new Map<
      number,
      Map<string, DubbingSpeakerSettings>
    >();
    meta.cues.forEach((persisted, index) => {
      const newAssignment = refreshed.assignments[index];
      if (!newAssignment) return;
      const newPrimary = primaryDubbingSpeakerId(newAssignment);
      const oldPrimary = primaryDubbingSpeakerId(persisted);
      if (!newPrimary) return;
      const choices =
        settingsCandidates.get(newPrimary) ||
        new Map<string, DubbingSpeakerSettings>();
      const addSettings = (value: DubbingSpeakerSettings) => {
        assertDubbingSpeakerSettings(value);
        choices.set(`${value.speed}:${value.pitch}`, value);
      };
      if (speakerSettings[String(newPrimary)])
        addSettings(speakerSettings[String(newPrimary)]);
      if (oldPrimary)
        addSettings(
          resolveDubbingSpeakerSettings(persisted, meta.speakerSettings),
        );
      for (const id of new Set([newPrimary, oldPrimary])) {
        if (id)
          (meta.speakerSettingsConflicts?.[String(id)] || []).forEach(
            addSettings,
          );
      }
      settingsCandidates.set(newPrimary, choices);
      const values = candidates.get(newPrimary) || new Set<string>();
      const currentVoice = speakerVoiceMap[String(newPrimary)];
      const previousVoice = oldPrimary
        ? speakerVoiceMap[String(oldPrimary)]
        : undefined;
      if (currentVoice) values.add(currentVoice);
      if (previousVoice) values.add(previousVoice);
      candidates.set(newPrimary, values);
    });
    for (const [speakerId, voices] of candidates) {
      if (voices.size === 1) {
        speakerVoiceMap[String(speakerId)] = Array.from(voices)[0];
        delete speakerVoiceConflicts[String(speakerId)];
      } else if (voices.size > 1) {
        delete speakerVoiceMap[String(speakerId)];
        speakerVoiceConflicts[String(speakerId)] = Array.from(voices);
      }
    }
    for (const [speakerId, choices] of settingsCandidates) {
      if (choices.size === 1) {
        speakerSettings[String(speakerId)] = Array.from(choices.values())[0];
        delete speakerSettingsConflicts[String(speakerId)];
      } else if (choices.size > 1) {
        speakerSettingsConflicts[String(speakerId)] = Array.from(
          choices.values(),
        );
      }
    }
  }

  const session: DubbingSession = {
    id: meta.sessionId,
    subtitlePath: meta.subtitlePath,
    subtitleHash: meta.subtitleHash,
    videoPath:
      meta.videoPath && fs.existsSync(meta.videoPath)
        ? meta.videoPath
        : undefined,
    mediaDurationMs: meta.mediaDurationMs,
    workDir: getSessionDir(meta.sessionId),
    running: false,
    abort: null,
    // 优先还原落盘校准（旧版 meta 无此字段则从零累计）
    calibration:
      meta.calibration &&
      Number.isFinite(meta.calibration.totalEstimatedMs) &&
      Number.isFinite(meta.calibration.totalMeasuredMs)
        ? {
            totalEstimatedMs: meta.calibration.totalEstimatedMs,
            totalMeasuredMs: meta.calibration.totalMeasuredMs,
          }
        : createCalibration(),
    lastConfig: meta.configSnapshot,
    pendingTaskLink: meta.pendingTaskLink,
    hasSavedTextEdits: meta.hasSavedTextEdits,
    pipelineConfigSnapshot: meta.pipelineConfigSnapshot,
    subtitleLanguage:
      meta.subtitleLanguage ??
      dubbingSubtitleLanguage(meta.subtitlePath, meta.proofreadDataFile),
    detectedLanguage: meta.detectedLanguage,
    proofreadDataFile: refreshed.proofreadDataFile || meta.proofreadDataFile,
    speakers: hasRefreshedMetadata ? refreshed.speakers : meta.speakers || [],
    speakerVoiceMap,
    speakerSettings,
    speakerSettingsConflicts,
    speakerVoiceConflicts,
    cues: meta.cues.map((persisted) => {
      const resolved = resolvePersistedCue(meta.sessionId, persisted);
      const assignment = hasRefreshedMetadata
        ? refreshed.assignments[resolved.index] || {}
        : resolved;
      return {
        index: resolved.index,
        startMs: resolved.startMs,
        endMs: resolved.endMs,
        text: resolved.text,
        voiceId: resolved.voiceId,
        ...(Object.prototype.hasOwnProperty.call(assignment, 'speakerIds')
          ? { speakerIds: [...(assignment.speakerIds || [])] }
          : {}),
        ...(assignment.primarySpeakerId
          ? { primarySpeakerId: assignment.primarySpeakerId }
          : {}),
        synthesizedVoiceId: resolved.synthesizedVoiceId,
        synthesizedInputKey: resolved.synthesizedInputKey,
        needsUpdate: resolved.needsUpdate,
        status: resolved.status,
        overlap: resolved.overlap,
        finalMs: resolved.finalMs,
        originalMeasuredMs: resolved.originalMeasuredMs,
        borrowedMs: resolved.borrowedMs,
        appliedSpeed: resolved.appliedSpeed,
        requiredFactor: resolved.requiredFactor,
        wavPath: resolved.wavPath,
        error: resolved.error,
        action: resolved.action,
      };
    }),
  };
  if (session.lastConfig)
    syncDubbingVoiceStaleness(session, session.lastConfig);
  if (options?.cache !== false) sessions.set(session.id, session);
  logMessage(
    `dubbing session restored: ${session.id} (${session.cues.filter((c) => c.wavPath).length}/${session.cues.length} cues with artifacts)`,
    'info',
  );
  return { kind: 'ok', session };
}

/**
 * 释放会话（换文件/关页面）：目录与元数据保留，重开可恢复。
 * keepRunning=true（页面离开）且批量进行中时不中断执行——批量在后台继续，
 * 会话保留在内存，经最近任务回开可实时重连；完成后由 IPC 层更新工作项状态。
 */
export function disposeDubbingSession(
  id: string,
  opts?: { keepRunning?: boolean },
): void {
  const session = sessions.get(id);
  if (!session) return;
  if (opts?.keepRunning && session.running) {
    persistDubbingSession(session);
    return;
  }
  session.abort?.abort();
  sessions.delete(id);
  const hasArtifacts = session.cues.some(
    (c) => c.wavPath || c.status === 'failed',
  );
  const hasRoleSettings =
    Object.keys(session.speakerVoiceMap).length > 0 ||
    Object.keys(session.speakerSettings || {}).length > 0;
  if (
    hasArtifacts ||
    hasRoleSettings ||
    session.workItemId ||
    session.lastConfig ||
    session.hasSavedTextEdits
  ) {
    flushDubbingSession(session);
  } else {
    session.disposed = true;
    deleteSessionData(id);
  }
}

/** 彻底删除会话数据（工作项删除联动/用户确认重建）。 */
export function deleteDubbingSessionData(id: string): void {
  deleteSessionData(id);
  forgetDubbingSession(id);
}

export function forgetDubbingSession(id: string): void {
  const session = sessions.get(id);
  if (session) {
    // 先置 disposed 再 abort：进行中批量被中断后，其 finally/行级落盘
    // 全部变 no-op，避免把刚删除的会话目录重新写回
    session.disposed = true;
    session.abort?.abort();
    sessions.delete(id);
  }
}

// ── 引擎适配（本地 worker / 云端 service 收敛为统一 synth 函数）──────────────

interface EngineAdapter {
  concurrency: number;
  synthesize: (
    text: string,
    voiceId: string,
    speed: number,
    outWavPath: string,
    signal?: AbortSignal,
    language?: string,
    preview?: import('../../../types/ttsProvider').TtsSegmentRequest['preview'],
  ) => Promise<{ durationMs: number }>;
}

function buildEngineAdapter(
  engine: DubbingEngineSelection,
  opts?: { cloneQuality?: 'standard' | 'high'; localConcurrency?: number },
): EngineAdapter {
  if (engine.kind === 'local') {
    const modelId = engine.modelId as TtsModelId;
    const spec = TTS_MODELS[modelId];
    if (!spec) throw new Error(`未知本地 TTS 模型：${engine.modelId}`);
    if (!isTtsModelInstalled(modelId)) {
      throw new Error(
        `本地模型 ${spec.displayName} 未安装，请先在「配音服务」页下载`,
      );
    }
    const model = getTtsModelRequest(modelId);
    const runtime = getSherpaTtsRuntime();
    // 本地并行合成：进程池按需扩展（每路一份模型驻留内存，批量结束收缩）。
    const localConcurrency = Math.max(
      1,
      Math.min(3, Math.floor(Number(opts?.localConcurrency)) || 1),
    );
    runtime.setPoolSize(localConcurrency);

    const runSynthesize = async (
      req: Parameters<typeof runtime.synthesize>[0],
      signal?: AbortSignal,
    ) => {
      if (signal?.aborted) throw new TaskCancelledError();
      const { id, result } = runtime.synthesize(req);
      const onAbort = () => runtime.cancel(id);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const r = await result;
        return { durationMs: r.durationMs };
      } catch (e) {
        if ((e as { code?: string })?.code === 'cancelled') {
          throw new TaskCancelledError();
        }
        throw e;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    };

    if (spec.cloneOnly) {
      // 零样本克隆（zipvoice）：voiceId = 克隆音色 id，参考对随每次合成注入。
      // speed 参数实测严重非线性 → 声明 'none'，行级时长收敛走 atempo 复测分支；
      // 用户整体语速仍经 speed 透传（听感调节，不参与对齐决策）。
      const { getClonedVoiceById } =
        require('../voiceClone/voiceCloneManager') as typeof import('../voiceClone/voiceCloneManager');
      return {
        concurrency: localConcurrency, // 进程池并行（每路一份模型内存）
        synthesize: async (
          text,
          voiceId,
          speed,
          outWavPath,
          signal,
          language,
        ) => {
          if (localTtsLanguageError(modelId, language))
            throw new Error(
              `${spec.displayName} 不支持配音语言 ${language}，请选择支持该语言的引擎`,
            );
          const voice = getClonedVoiceById(voiceId);
          if (!voice || voice.engine !== 'zipvoice') {
            throw new Error('克隆音色不存在或已删除，请重新选择音色');
          }
          if (!voice.refWavPath || !fs.existsSync(voice.refWavPath)) {
            throw new Error(
              `克隆音色「${voice.name}」的参考音频缺失，请删除后重新创建`,
            );
          }
          const r = await runSynthesize(
            {
              model,
              text,
              language,
              sid: 0,
              speed,
              outWavPath,
              generationConfig: {
                refWavPath: voice.refWavPath,
                refText: voice.refText || '',
                referenceLanguage: voice.language,
                // 质量档：standard=4（RTF~0.44）/ high=8（~0.91，约两倍耗时）。
                numSteps: opts?.cloneQuality === 'high' ? 8 : 4,
              },
            },
            signal,
          );
          // 跨语言压缩矫正（闭环、确定性）：英文参考 + 中文文本时模型
          // 时长预测严重不足，中文被压到 8–12 字/秒（自然 3.5–5.5，听感
          // 含糊）。speed 参数实测悬崖式非线性（0.53 → 0.9 字/秒过冲
          // 10 倍）不可用——改按实测字符速率超阈即 atempo 慢放到目标
          // 速率（线性精确）。慢放后仍超槽位的行走既有过长兜底。
          const zhChars = cjkCharCount(text);
          if (zhChars >= 4 && r.durationMs > 0) {
            const cps = zhChars / (r.durationMs / 1000);
            if (cps > CLONE_ZH_RATE_MAX_CPS) {
              const factor = Math.max(
                CLONE_CORRECTIVE_SPEED_MIN,
                CLONE_ZH_RATE_TARGET_CPS / cps,
              );
              const ratePath = outWavPath.replace(/\.wav$/i, '.rate.wav');
              await atempoWav(outWavPath, ratePath, factor, signal);
              fs.copyFileSync(ratePath, outWavPath);
              fs.rmSync(ratePath, { force: true });
              return { durationMs: wavDurationMs(outWavPath) };
            }
          }
          return r;
        },
      };
    }

    return {
      concurrency: localConcurrency, // 进程池并行（每路一份模型内存）
      synthesize: async (
        text,
        voiceId,
        speed,
        outWavPath,
        signal,
        language,
      ) => {
        if (localTtsLanguageError(modelId, language))
          throw new Error(
            `${spec.displayName} 不支持配音语言 ${language}，请选择支持该语言的引擎`,
          );
        return runSynthesize(
          {
            model: resolveTtsModelRequestForVoice(
              spec,
              model,
              voiceId,
              language,
            ),
            text,
            language,
            sid: resolveTtsVoiceSid(spec, voiceId),
            speed,
            outWavPath,
          },
          signal,
        );
      },
    };
  }

  const provider = getTtsProviderById(engine.providerId);
  if (!provider)
    throw new Error('所选云端配音服务商不存在，请先在「引擎与模型」页配置');
  const caps = getTtsCapabilities(provider.type);
  const concurrency = Math.max(
    1,
    Math.floor(Number(provider.concurrency)) || caps.concurrency || 1,
  );
  const gate = getCloudProviderGate(`tts:${provider.id}`);
  gate.setLimits(concurrency, resolveTtsRequestIntervalMs(provider));
  return {
    concurrency,
    synthesize: async (
      text,
      voiceId,
      speed,
      outWavPath,
      signal,
      language,
      preview,
    ) => {
      const release = await gate.acquire(signal);
      try {
        const r = await synthesizeSegment(provider, {
          text,
          language,
          voice: voiceId,
          speed,
          outWavPath,
          signal,
          preview,
        });
        return { durationMs: r.durationMs };
      } finally {
        release();
      }
    },
  };
}

// ── 单行合成 + 对齐复测（batch 与单行重生成共用）────────────────────────────

async function synthesizeAndAlignCue(
  session: DubbingSession,
  cue: SessionCue,
  slot: CueSlot,
  adapter: EngineAdapter,
  config: DubbingConfig,
  signal?: AbortSignal,
  retainPreviousArtifact = false,
): Promise<void> {
  const globalSpeed =
    Number.isFinite(config.globalSpeed) && config.globalSpeed > 0
      ? config.globalSpeed
      : 1;
  const voiceId = resolvedSessionCueVoice(session, cue, config.voice);
  const speakerSettings = resolveDubbingSpeakerSettings(
    cue,
    session.speakerSettings,
  );
  const previousWavPath = cue.wavPath;
  const attemptId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const wavPath = path.join(
    session.workDir,
    `cue-${cue.index}-${attemptId}.wav`,
  );
  const attemptPaths = new Set([wavPath]);
  try {
    // 会话/展示字幕保留 `[Speaker N]`；仅在估时与 TTS 的最终输入边界剥离。
    const speechText = normalizeDubbingSpeechText(cue.text);
    const language = resolvedDubbingLanguage(config, voiceId, session);
    const inputKey = dubbingInputKey(
      config,
      voiceId,
      speechText,
      language,
      speakerSettings,
      { startMs: cue.startMs, endMs: cue.endMs },
    );

    if (!speechText) {
      // 空行：静音占位，无需合成。
      cue.status = 'done';
      cue.finalMs = 0;
      cue.originalMeasuredMs = 0;
      cue.borrowedMs = undefined;
      cue.requiredFactor = undefined;
      cue.appliedSpeed = 1;
      cue.wavPath = undefined;
      cue.synthesizedVoiceId = voiceId;
      cue.synthesizedInputKey = inputKey;
      cue.needsUpdate = false;
      cue.action = { type: 'none' };
      return;
    }

    const est = estimateDurationMs(speechText);
    let appliedExtra = 1;
    const synthSpeed = globalSpeed;
    const r = await adapter.synthesize(
      speechText,
      voiceId,
      synthSpeed,
      wavPath,
      signal,
      language,
    );
    // 校准样本：折回 1.0x 等效时长（实测 × 综合速度）。
    // 并发安全不变式：读旧值与写新值必须保持在同一条同步语句内（中间不得插入
    // await），Node 单线程下即原子累加；拆开会在并行合成时丢样本。
    session.calibration = updateCalibration(
      session.calibration,
      est,
      Math.round(r.durationMs * synthSpeed),
    );

    let currentWav = wavPath;
    const applyRole = async () => {
      currentWav = wavPath;
      if (speakerSettings.speed === 1 && speakerSettings.pitch === 0) return;
      const rolePath = path.join(
        session.workDir,
        `cue-${cue.index}-${attemptId}-role.wav`,
      );
      attemptPaths.add(rolePath);
      await applySpeakerSettingsWav(wavPath, rolePath, speakerSettings, signal);
      currentWav = rolePath;
    };
    await applyRole();
    let action: AlignmentSpeedAction = { type: 'none' };
    let overlong = false;
    let requiredFactor: number | undefined;
    const originalMeasuredMs = wavDurationMs(currentWav);

    // Measure at user speed; never resynthesize or borrow silence automatically.
    for (;;) {
      if (signal?.aborted) throw new TaskCancelledError();
      const measured = wavDurationMs(currentWav);
      const recheck = recheckAfterSynthesis(
        measured,
        slot.slotMs,
        appliedExtra,
        {
          canResynthesize: false,
        },
      );
      if (recheck.type === 'fit') break;
      if (recheck.type === 'overlong') {
        overlong = true;
        requiredFactor = recheck.requiredFactor;
        break;
      }
      // atempo：对已产出 wav 后处理变速。
      const tempoPath = path.join(
        session.workDir,
        `cue-${cue.index}-${attemptId}-atempo.wav`,
      );
      attemptPaths.add(tempoPath);
      await fitSpeechWav(currentWav, tempoPath, slot.slotMs, signal);
      currentWav = tempoPath;
      appliedExtra *= recheck.factor;
      action = { type: 'atempo', factor: recheck.factor };
      break;
    }

    const finalMs = wavDurationMs(currentWav);
    if (signal?.aborted || session.disposed) throw new TaskCancelledError();
    cue.wavPath = currentWav;
    cue.finalMs = finalMs;
    cue.originalMeasuredMs = originalMeasuredMs;
    cue.borrowedMs = undefined;
    cue.appliedSpeed = appliedExtra;
    cue.action = action;
    cue.requiredFactor = requiredFactor;
    cue.status = overlong ? 'overlong' : 'done';
    cue.error = undefined;
    cue.synthesizedVoiceId = voiceId;
    cue.synthesizedInputKey = inputKey;
    cue.needsUpdate = false;
    if (
      !retainPreviousArtifact &&
      previousWavPath &&
      previousWavPath !== currentWav
    ) {
      try {
        if (
          path.dirname(previousWavPath) === session.workDir &&
          fs.existsSync(previousWavPath)
        ) {
          fs.unlinkSync(previousWavPath);
        }
      } catch {
        // The new artifact is already authoritative; stale-file cleanup is best effort.
      }
    }
  } finally {
    for (const file of attemptPaths) {
      if (file === cue.wavPath) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        // Only paths from this attempt are eligible for cleanup.
      }
    }
  }
}

// ── 批量合成 ────────────────────────────────────────────────────────────────

export interface BatchResult {
  doneCount: number;
  overlongIndexes: number[];
  overlapIndexes: number[];
  failedIndexes: number[];
  cancelled?: boolean;
}

/**
 * 批量合成：处理所有非 done 行（pending/failed/overlong 重跑），
 * 本地串行、云端按并发闸并行；单行失败不中断，结束汇总。
 * force = 全量重跑（全部完成后改了 voice/语速再来一遍的场景）。
 */
export async function runDubbingBatch(
  session: DubbingSession,
  config: DubbingConfig,
  onProgress: (e: DubbingProgressEvent) => void,
  opts?: { force?: boolean; staleOnly?: boolean; speakerId?: number },
): Promise<BatchResult> {
  if (session.running || session.disposed)
    throw new Error('该会话已有合成任务进行中或已关闭');
  assertSpeakerConflictsResolved(session);
  const missingSpeakers = missingDubbingSpeakerVoiceIds(
    session.speakers,
    session.speakerVoiceMap,
  );
  if (missingSpeakers.length) {
    throw new Error(`还有 ${missingSpeakers.length} 个角色未选择音色`);
  }
  syncDubbingVoiceStaleness(session, config);
  const adapter = buildEngineAdapter(config.engine, {
    cloneQuality: config.cloneQuality,
    localConcurrency: config.localConcurrency,
  });
  session.running = true;
  session.abort = new AbortController();
  session.lastConfig = config;
  const signal = session.abort.signal;

  const slots = computeSlots(
    session.cues.map((c) => ({ ...c, borrowedMs: undefined })),
    {
      mediaDurationMs: session.mediaDurationMs || undefined,
    },
  );
  const slotByIndex = new Map(slots.map((s) => [s.index, s]));

  const targets = session.cues.filter((cue) => {
    if (
      opts?.speakerId !== undefined &&
      primaryDubbingSpeakerId(cue) !== opts.speakerId
    ) {
      return false;
    }
    if (opts?.staleOnly) return Boolean(cue.needsUpdate);
    if (opts?.force) return true;
    return (
      cue.needsUpdate || (cue.status !== 'done' && cue.status !== 'accepted')
    );
  });
  const total = targets.length;
  let processed = 0;
  let cancelled = false;

  const emit = (cue: SessionCue, stage: DubbingStage) => {
    onProgress({
      taskId: session.id,
      stage,
      percent: total > 0 ? Math.round((processed / total) * 100) : 100,
      cueIndex: cue.index,
      cueStatus: cue.status,
    });
  };

  const runOne = async (cue: SessionCue) => {
    if (signal.aborted) return;
    const previous = { ...cue };
    cue.status = 'synthesizing';
    emit(cue, 'synthesize');
    try {
      await synthesizeAndAlignCue(
        session,
        cue,
        slotByIndex.get(cue.index)!,
        adapter,
        config,
        signal,
        true,
      );
      try {
        flushSessionMeta(toSessionMeta(session), true);
      } catch (error) {
        const generated = cue.wavPath;
        Object.assign(cue, previous);
        if (generated && generated !== previous.wavPath) {
          try {
            fs.unlinkSync(generated);
          } catch {
            /* attempt cleanup */
          }
        }
        throw error;
      }
      if (
        previous.wavPath &&
        previous.wavPath !== cue.wavPath &&
        path.dirname(previous.wavPath) === session.workDir
      ) {
        try {
          fs.unlinkSync(previous.wavPath);
        } catch {
          /* stale artifact cleanup */
        }
      }
    } catch (e) {
      if (e instanceof TaskCancelledError || signal.aborted) {
        cancelled = true;
        cue.status = 'pending';
      } else {
        cue.status = 'failed';
        cue.error = e instanceof Error ? e.message : String(e);
        logMessage(`dubbing cue ${cue.index} failed: ${cue.error}`, 'warning');
      }
    }
    processed += 1;
    emit(cue, 'synthesize');
    // 行级状态节流落盘：崩溃/退出后重开最多丢一个防抖窗口
    persistDubbingSession(session);
  };

  try {
    if (adapter.concurrency <= 1) {
      for (const cue of targets) {
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        await runOne(cue);
      }
    } else {
      // 云端：固定 worker 数拉取队列（并发闸在 adapter 内二次保险）。
      let next = 0;
      const workerCount = Math.min(adapter.concurrency, targets.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          for (;;) {
            if (signal.aborted) return;
            const i = next++;
            if (i >= targets.length) return;
            await runOne(targets[i]);
          }
        }),
      );
      if (signal.aborted) cancelled = true;
    }
  } finally {
    session.running = false;
    session.abort = null;
    flushDubbingSession(session);
    // 并行批量结束：进程池收缩回 1（每个成员一份模型驻留内存）。
    if (config.engine.kind === 'local' && adapter.concurrency > 1) {
      getSherpaTtsRuntime().shrinkTo(1);
    }
  }

  return {
    doneCount: session.cues.filter(
      (c) => !c.needsUpdate && (c.status === 'done' || c.status === 'accepted'),
    ).length,
    overlongIndexes: session.cues
      .filter((c) => c.status === 'overlong')
      .map((c) => c.index),
    overlapIndexes: session.cues.filter((c) => c.overlap).map((c) => c.index),
    failedIndexes: session.cues
      .filter((c) => c.status === 'failed')
      .map((c) => c.index),
    cancelled,
  };
}

// ── 单行操作 ────────────────────────────────────────────────────────────────

/** 单行重合成（可携新文本/voice）：仅该行重跑合成+复测，不影响其余行。 */
export async function resynthesizeCue(
  session: DubbingSession,
  index: number,
  overrides: {
    text?: string;
    voiceId?: string;
    expectedCue?: {
      text: string;
      wavPath?: string;
      synthesizedInputKey?: string;
      voiceId?: string;
    };
  },
  config: DubbingConfig,
): Promise<SessionCue> {
  assertSpeakerConflictsResolved(session);
  const cue = session.cues.find((c) => c.index === index);
  if (!cue) throw new Error(`行不存在：${index}`);
  if (session.running || session.disposed)
    throw new Error('Dubbing session is busy or unavailable');
  if (
    overrides.expectedCue &&
    Object.entries(overrides.expectedCue).some(
      ([key, value]) => cue[key] !== value,
    )
  )
    throw new Error('配音行已在其他窗口变化，请重新缩写');
  const hadPreviousArtifact = Boolean(cue.wavPath);

  const adapter = buildEngineAdapter(config.engine, {
    cloneQuality: config.cloneQuality,
  });
  // Save the requested edit before generating audio; a failed attempt remains retryable.
  commitSpeakerChange(session, config, () => {
    if (overrides.text !== undefined) cue.text = overrides.text;
    if (overrides.voiceId !== undefined)
      cue.voiceId = overrides.voiceId || undefined;
  });
  const previous = { ...cue };

  const slots = computeSlots(
    session.cues.map((c) => ({ ...c, borrowedMs: undefined })),
    {
      mediaDurationMs: session.mediaDurationMs || undefined,
    },
  );
  const slot = slots.find((s) => s.index === index)!;

  session.abort = new AbortController();
  session.running = true;
  cue.status = 'synthesizing';
  try {
    await synthesizeAndAlignCue(
      session,
      cue,
      slot,
      adapter,
      config,
      session.abort.signal,
      true,
    );
    try {
      flushSessionMeta(toSessionMeta(session), true);
    } catch (error) {
      const generated = cue.wavPath;
      Object.assign(cue, previous);
      if (generated && generated !== previous.wavPath) {
        try {
          fs.unlinkSync(generated);
        } catch {
          /* attempt cleanup */
        }
      }
      throw error;
    }
    if (
      previous.wavPath &&
      previous.wavPath !== cue.wavPath &&
      path.dirname(previous.wavPath) === session.workDir
    ) {
      try {
        fs.unlinkSync(previous.wavPath);
      } catch {
        /* stale artifact cleanup */
      }
    }
  } catch (e) {
    if (e instanceof TaskCancelledError) {
      cue.status = 'pending';
      throw e;
    }
    cue.status = 'failed';
    cue.error = e instanceof Error ? e.message : String(e);
    if (hadPreviousArtifact) cue.needsUpdate = true;
    throw e;
  } finally {
    session.running = false;
    session.abort = null;
    flushDubbingSession(session);
  }
  return cue;
}

/** 行级 voice 覆盖仅记录（pending 行：批量合成时生效，不触发合成）。 */
export function setCueVoiceOverride(
  session: DubbingSession,
  index: number,
  voiceId: string,
): SessionCue {
  if (session.running || session.disposed)
    throw new Error('Dubbing session is busy or unavailable');
  if (typeof voiceId !== 'string') throw new Error('Invalid voice ID');
  const cue = session.cues.find((c) => c.index === index);
  if (!cue) throw new Error(`行不存在：${index}`);
  commitSpeakerChange(session, session.lastConfig, () => {
    cue.voiceId = voiceId || undefined;
    if (cue.wavPath) cue.needsUpdate = true;
  });
  return cue;
}

export function setSpeakerVoiceMapping(
  session: DubbingSession,
  speakerId: number,
  voiceId: string,
  globalVoiceId: string,
  config?: DubbingConfig,
): { affectedCount: number } {
  if (session.running || session.disposed)
    throw new Error('Dubbing session is busy or unavailable');
  if (!session.speakers.some((speaker) => speaker.id === speakerId)) {
    throw new Error(`角色不存在：${speakerId}`);
  }
  if (typeof voiceId !== 'string' || !voiceId.trim())
    throw new Error('角色音色不能为空');
  commitSpeakerChange(session, config, () => {
    session.speakerVoiceMap = {
      ...session.speakerVoiceMap,
      [String(speakerId)]: voiceId,
    };
    session.speakerVoiceConflicts = { ...session.speakerVoiceConflicts };
    delete session.speakerVoiceConflicts[String(speakerId)];
    if (!config) {
      for (const cue of session.cues) {
        if (!cueInheritsSpeaker(cue, speakerId) || !cue.wavPath) continue;
        const resolved = resolvedSessionCueVoice(session, cue, globalVoiceId);
        const synthesizedVoiceId =
          cue.synthesizedVoiceId || session.lastConfig?.voice;
        cue.needsUpdate =
          Boolean(cue.needsUpdate) ||
          Boolean(synthesizedVoiceId && synthesizedVoiceId !== resolved);
      }
    }
  });
  const affectedCount = session.cues.filter(
    (cue) =>
      cueInheritsSpeaker(cue, speakerId) && cue.wavPath && cue.needsUpdate,
  ).length;
  return { affectedCount };
}

export function saveDubbingCueTexts(
  session: DubbingSession,
  value: unknown,
): void {
  if (session.running || session.disposed)
    throw new Error('Dubbing session is busy or unavailable');
  const edits = parseDubbingCueEdits(value);
  const cuesByIndex = new Map(session.cues.map((cue) => [cue.index, cue]));
  const changes = edits.map((edit) => {
    const cue = cuesByIndex.get(edit.index);
    if (
      !cue ||
      cue.startMs !== edit.startMs ||
      cue.endMs !== edit.endMs ||
      (cue.text !== edit.baseText && cue.text !== edit.text)
    )
      throw new Error(
        `Dubbing cue ${edit.index + 1} changed; review the saved text before retrying`,
      );
    return { cue, edit };
  });
  // Validate the entire batch first. Identical replay is safe after a lost reply.
  commitSpeakerChange(session, session.lastConfig, () => {
    for (const { cue, edit } of changes) {
      if (cue.text === edit.text) continue;
      cue.text = edit.text;
      if (cue.wavPath) cue.needsUpdate = true;
    }
    if (changes.length) session.hasSavedTextEdits = true;
    if (!session.lastConfig)
      session.detectedLanguage =
        detectDubbingLanguage(session.cues.map((cue) => cue.text).join('\n')) ??
        session.detectedLanguage;
  });
}

export function saveDubbingConfig(
  session: DubbingSession,
  config: DubbingConfig,
): void {
  if (session.running || session.disposed)
    throw new Error('Dubbing session is busy or unavailable');
  assertDubbingConfig(config);
  commitSpeakerChange(session, structuredClone(config), () => {});
}

function commitSpeakerChange(
  session: DubbingSession,
  config: DubbingConfig | undefined,
  change: () => void,
): void {
  const previous = {
    speakerVoiceMap: session.speakerVoiceMap,
    speakerVoiceConflicts: session.speakerVoiceConflicts,
    speakerSettings: session.speakerSettings,
    speakerSettingsConflicts: session.speakerSettingsConflicts,
    detectedLanguage: session.detectedLanguage,
    lastConfig: session.lastConfig,
    hasSavedTextEdits: session.hasSavedTextEdits,
  };
  const cueStates = session.cues.map((cue) => ({
    text: cue.text,
    voiceId: cue.voiceId,
    needsUpdate: cue.needsUpdate,
    synthesizedVoiceId: cue.synthesizedVoiceId,
  }));
  try {
    change();
    if (config) {
      syncDubbingVoiceStaleness(session, config);
      session.lastConfig = config;
    }
    flushSessionMeta(toSessionMeta(session), true);
  } catch (error) {
    Object.assign(session, previous);
    session.cues.forEach((cue, index) => Object.assign(cue, cueStates[index]));
    throw error;
  }
}

export function setSpeakerSettings(
  session: DubbingSession,
  speakerId: number,
  settings: DubbingSpeakerSettings,
  config: DubbingConfig,
): void {
  if (session.running || session.disposed)
    throw new Error('Dubbing session is busy or unavailable');
  if (!session.speakers.some((speaker) => speaker.id === speakerId))
    throw new Error(`Unknown speaker: ${speakerId}`);
  assertDubbingSpeakerSettings(settings);
  commitSpeakerChange(session, config, () => {
    session.speakerSettings = {
      ...session.speakerSettings,
      [String(speakerId)]: { speed: settings.speed, pitch: settings.pitch },
    };
    session.speakerSettingsConflicts = { ...session.speakerSettingsConflicts };
    delete session.speakerSettingsConflicts[String(speakerId)];
  });
}

export async function setDubbingMedia(
  session: DubbingSession,
  videoPath: string | undefined,
): Promise<void> {
  if (session.running || session.disposed)
    throw new Error('Dubbing session is busy or unavailable');
  session.running = true;
  const previous = {
    videoPath: session.videoPath,
    mediaDurationMs: session.mediaDurationMs,
  };
  const previousCues = session.cues.map((cue) => ({ ...cue }));
  try {
    if (videoPath && !fs.statSync(videoPath).isFile())
      throw new Error('媒体路径不是文件');
    const mediaDurationMs = videoPath
      ? await probeMediaDurationMs(videoPath)
      : 0;
    if (videoPath && mediaDurationMs <= 0) throw new Error('无法读取媒体时长');
    if (session.disposed || sessions.get(session.id) !== session)
      throw new Error('Dubbing session is unavailable');
    session.videoPath = videoPath;
    session.mediaDurationMs = mediaDurationMs;
    const slots = computeSlots(session.cues, {
      mediaDurationMs: mediaDurationMs || undefined,
    });
    const slotByIndex = new Map(slots.map((slot) => [slot.index, slot]));
    for (const cue of session.cues) {
      if (
        !cue.wavPath ||
        !['done', 'accepted', 'overlong'].includes(cue.status)
      )
        continue;
      const duration = wavDurationMs(cue.wavPath);
      const slot = slotByIndex.get(cue.index)!;
      if (duration > slot.slotMs) {
        cue.borrowedMs = undefined;
        cue.status = 'overlong';
        cue.requiredFactor =
          slot.slotMs > 0 ? duration / slot.slotMs : Infinity;
      } else if (cue.status === 'overlong') {
        cue.status = 'done';
        cue.requiredFactor = undefined;
      }
    }
    flushSessionMeta(toSessionMeta(session), true);
  } catch (error) {
    Object.assign(session, previous);
    session.cues.forEach((cue, index) =>
      Object.assign(cue, previousCues[index]),
    );
    throw error;
  } finally {
    session.running = false;
  }
}

function assertSpeakerConflictsResolved(session: DubbingSession): void {
  const unresolved = session.speakers.some(
    (speaker) =>
      (session.speakerVoiceConflicts[String(speaker.id)]?.length || 0) > 1 ||
      (session.speakerSettingsConflicts?.[String(speaker.id)]?.length || 0) > 1,
  );
  if (unresolved) throw new Error('请先确认合并角色的音色和语速/音高设置');
}

/** Keep the complete WAV, extending only this cue into verified following silence. */
export function borrowFollowingSilence(
  session: DubbingSession,
  index: number,
  config: DubbingConfig,
): SessionCue {
  if (session.running || session.disposed)
    throw new Error('Dubbing session is busy or unavailable');
  assertSpeakerConflictsResolved(session);
  syncDubbingVoiceStaleness(session, config);
  const cue = session.cues.find((c) => c.index === index);
  if (!cue) throw new Error(`行不存在：${index}`);
  if (cue.needsUpdate) throw new Error('请先重新生成已变化的配音');
  if (cue.status !== 'overlong' || !cue.wavPath) {
    throw new Error('该行不是待处理的过长行');
  }
  const slots = computeSlots(session.cues, {
    mediaDurationMs: session.mediaDurationMs || undefined,
  });
  const slot = slots.find((s) => s.index === index)!;
  const measured = wavDurationMs(cue.wavPath);
  const needed = measured - slot.slotMs;
  if (needed <= 0 || needed > slot.availableGapMs)
    throw new Error(
      '后续空白不足，无法在不覆盖其他字幕或超出媒体结尾的前提下延长',
    );
  const previous = { ...cue };
  try {
    cue.borrowedMs = needed;
    cue.finalMs = measured;
    cue.status = 'accepted';
    cue.error = undefined;
    flushSessionMeta(toSessionMeta(session), true);
  } catch (error) {
    Object.assign(cue, previous);
    throw error;
  }
  return cue;
}

// ── 导出 ────────────────────────────────────────────────────────────────────

export interface ExportResult {
  /** 主产物（音频或视频）。 */
  outputPath: string;
  /** 可选顺延字幕。 */
  shiftedSubtitlePath?: string;
  /** 无合成产物被跳过的行（失败/未合成）。 */
  skippedIndexes: number[];
  plan: AlignmentPlan;
}

/** 汇总当前会话的最终规划（供导出与 UI 概览）。 */
export function buildSessionPlan(
  session: DubbingSession,
  overflow: 'truncate' | 'shift',
  overlapMode: 'shift' | 'mix' = 'shift',
): AlignmentPlan {
  const slots = computeSlots(session.cues, {
    mediaDurationMs: session.mediaDurationMs || undefined,
  });
  const finals: FinalCue[] = session.cues
    .filter((c) => c.wavPath && c.finalMs !== undefined)
    .map((c) => ({
      index: c.index,
      startMs: c.startMs,
      durationMs: c.finalMs!,
      action: c.action,
      overlong: c.status === 'overlong',
    }));
  return buildAlignmentPlan(finals, slots, { overflow, overlapMode });
}

/** buildDubTrack 产物：完整配音轨 + 可选顺延字幕 + 规划。 */
export interface DubTrackResult {
  /** 完整配音轨 wav（会话目录内，锚定媒体时间轴） */
  trackPath: string;
  shiftedSubtitlePath?: string;
  /** 无合成产物被跳过的行（失败/未合成） */
  skippedIndexes: number[];
  plan: AlignmentPlan;
}

/**
 * 由会话已合成行构建完整配音轨（规划 → 槽位拼接 → 多轨混流），可选产出顺延字幕。
 * 不做视频封装（导出/合成阶段各自处理）。工作台导出与流水线配音阶段共用。
 */
export async function buildDubTrack(
  session: DubbingSession,
  opts: DubTrackOptions,
): Promise<DubTrackResult> {
  if (
    session.disposed ||
    (session.running && (!opts.signal || session.abort?.signal !== opts.signal))
  )
    throw new Error('配音会话正在使用中或已关闭，请稍后重试');
  const ownsLock = !session.running;
  const controller = ownsLock ? new AbortController() : session.abort!;
  const onAbort = () => controller.abort();
  if (ownsLock) {
    session.running = true;
    session.abort = controller;
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) controller.abort();
  }
  let directory: string | undefined;
  try {
    controller.signal.throwIfAborted();
    directory = fs.mkdtempSync(path.join(session.workDir, 'dub-track-'));
    return await buildDubTrackUnlocked(
      session,
      { ...opts, signal: controller.signal },
      directory,
    );
  } catch (error) {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (ownsLock) {
      opts.signal?.removeEventListener('abort', onAbort);
      session.running = false;
      session.abort = null;
    }
  }
}

interface DubTrackOptions {
  /** Current task/workbench synthesis settings, used to reject stale artifacts. */
  config: DubbingConfig;
  overflow?: DubbingOverflowMode;
  overlapMode?: DubbingOverlapMode;
  signal?: AbortSignal;
  /**
   * 顺延字幕输出：always=只要请求就写（工作台导出语义）；
   * ifShifted=仅当规划实际改变了时间轴才写（流水线语义）。
   * displayTextByIndex=展示文本覆盖（cue index → 文本）：流水线用交付字幕
   * 文本（如双语）替换配音用的纯译文，时间轴仍取规划结果；缺省用会话行文本。
   */
  shiftedSubtitle?: {
    path?: string;
    mode: 'always' | 'ifShifted';
    displayTextByIndex?: Map<number, string>;
    preserveOriginalWindows?: boolean;
  };
}

async function buildDubTrackUnlocked(
  session: DubbingSession,
  opts: DubTrackOptions,
  directory: string,
): Promise<DubTrackResult> {
  assertSpeakerConflictsResolved(session);
  const staleCount = syncDubbingVoiceStaleness(session, opts.config);
  if (staleCount > 0) {
    flushDubbingSession(session);
    throw new Error(
      `还有 ${staleCount} 条配音的语言、文本或合成设置已变化，请先重新生成`,
    );
  }
  const slots = computeSlots(session.cues, {
    mediaDurationMs: session.mediaDurationMs || undefined,
  });
  const slotByIndex = new Map(slots.map((slot) => [slot.index, slot]));
  const unresolved = session.cues.filter((cue) => {
    if (!normalizeDubbingSpeechText(cue.text)) return false;
    return (
      !cue.wavPath ||
      !['done', 'accepted'].includes(cue.status) ||
      wavDurationMs(cue.wavPath) > (slotByIndex.get(cue.index)?.slotMs ?? 0)
    );
  });
  if (unresolved.length)
    throw new Error(
      `还有 ${unresolved.length} 条配音未生成、失败或超限，请先处理后再导出`,
    );
  const withWav = session.cues.filter((c) => c.wavPath && c.finalMs);
  if (withWav.length === 0) {
    throw new Error('没有可导出的配音行，请先开始配音');
  }
  const overflow = opts.overflow ?? 'truncate';
  // Borrowing must not move any later cue, including pre-existing overlapping dialogue.
  const overlapMode = session.cues.some((cue) => cue.borrowedMs)
    ? 'mix'
    : (opts.overlapMode ?? 'mix');
  const signal = opts.signal;
  const plan = buildSessionPlan(session, overflow, overlapMode);
  const wavByIndex = new Map(session.cues.map((c) => [c.index, c.wavPath]));

  const trackPath = path.join(directory, 'dub-track.wav');
  const totalDurationMs =
    session.mediaDurationMs ||
    Math.max(...plan.items.map((i) => i.targetStartMs + i.durationMs), 0);

  // 按轨道分组（shift 模式恒单轨 0；mix 模式重叠行分轨锚定原时间轴）。
  const laneSegments = new Map<
    number,
    Array<{ wavPath: string; targetStartMs: number; maxDurationMs: number }>
  >();
  for (const item of plan.items) {
    const wav = wavByIndex.get(item.index);
    if (!wav) continue;
    const arr = laneSegments.get(item.lane) ?? [];
    arr.push({
      wavPath: wav,
      targetStartMs: item.targetStartMs,
      maxDurationMs: item.durationMs,
    });
    laneSegments.set(item.lane, arr);
  }
  const lanes: number[] = [];
  laneSegments.forEach((_, lane) => lanes.push(lane));
  lanes.sort((a, b) => a - b);
  if (lanes.length <= 1) {
    // 单轨：与顺延模式同路径，零额外开销。
    await assembleTrack(laneSegments.get(lanes[0] ?? 0) ?? [], trackPath, {
      totalDurationMs,
      signal,
    });
  } else {
    // 多轨：逐轨拼接（统一总时长）→ amix 合为单条配音轨（限幅防削波）。
    const laneTracks: string[] = [];
    for (const lane of lanes) {
      const lanePath = path.join(directory, `dub-lane-${lane}.wav`);
      await assembleTrack(laneSegments.get(lane)!, lanePath, {
        totalDurationMs,
        signal,
      });
      laneTracks.push(lanePath);
    }
    await amixWavs(laneTracks, trackPath, signal);
    for (const lanePath of laneTracks) fs.unlinkSync(lanePath);
  }
  signal?.throwIfAborted();

  // 顺延字幕：按规划后的时间轴序列化；ifShifted 模式仅在时间轴实际变化时产出
  let shiftedSubtitlePath: string | undefined;
  if (opts.shiftedSubtitle) {
    let timeline = shiftedTimeline(plan);
    if (opts.shiftedSubtitle.preserveOriginalWindows) {
      const planned = new Map(timeline.map((item) => [item.index, item]));
      timeline = session.cues.map((cue) => {
        const item = planned.get(cue.index);
        const startMs = item?.startMs ?? cue.startMs;
        return {
          index: cue.index,
          startMs,
          endMs: Math.max(
            cue.endMs + startMs - cue.startMs,
            item?.endMs ?? cue.endMs,
          ),
        };
      });
    }
    const originalByIndex = new Map(
      session.cues.map((c) => [c.index, c] as const),
    );
    const timelineChanged = timeline.some((t) => {
      const original = originalByIndex.get(t.index);
      return (
        !original ||
        t.startMs !== original.startMs ||
        t.endMs !== original.endMs
      );
    });
    if (opts.shiftedSubtitle.mode === 'always' || timelineChanged) {
      const textByIndex = new Map(session.cues.map((c) => [c.index, c.text]));
      const displayByIndex = opts.shiftedSubtitle.displayTextByIndex;
      const cues: SubtitleCue[] = timeline
        .filter((t) => t.endMs > t.startMs)
        .map((t) => ({
          startMs: t.startMs,
          endMs: t.endMs,
          text: displayByIndex?.get(t.index) ?? textByIndex.get(t.index) ?? '',
        }));
      shiftedSubtitlePath =
        opts.shiftedSubtitle.path ?? path.join(directory, 'dubbed-shifted.srt');
      fs.mkdirSync(path.dirname(shiftedSubtitlePath), { recursive: true });
      fs.writeFileSync(shiftedSubtitlePath, serializeSubtitleCues(cues, 'srt'));
    }
  }

  const planned = new Set(plan.items.map((i) => i.index));
  return {
    trackPath,
    shiftedSubtitlePath,
    skippedIndexes: session.cues
      .filter((c) => !planned.has(c.index) || !c.wavPath)
      .map((c) => c.index),
    plan,
  };
}

/** 导出：配音轨构建 → 背景音/输出形态 → 可选顺延字幕。 */
export async function exportDubbing(
  session: DubbingSession,
  config: DubbingConfig,
  onProgress: (e: DubbingProgressEvent) => void,
  onPublication?: (
    state: ComposePublicationState & { skippedIndexes: number[] },
  ) => void,
): Promise<ExportResult> {
  if (session.running || session.disposed)
    throw new Error('合成进行中或会话已关闭，请先等待或取消');
  const withWav = session.cues.filter((c) => c.wavPath && c.finalMs);
  if (withWav.length === 0) {
    throw new Error('没有可导出的配音行，请先开始配音');
  }
  if (!session.videoPath && config.output !== 'audioOnly') {
    throw new Error('未提供视频文件，只能导出纯音频');
  }

  session.running = true;
  session.abort = new AbortController();
  session.lastConfig = config;
  const signal = session.abort.signal;
  const emit = (stage: DubbingStage, percent: number) =>
    onProgress({ taskId: session.id, stage, percent });

  let output: ReturnType<typeof createComposeOutput> | undefined;
  let track: DubTrackResult | undefined;
  try {
    emit('concat', 10);
    output = createComposeOutput(
      resolveOutputPath(session, config),
      [
        session.subtitlePath,
        ...(session.videoPath ? [session.videoPath] : []),
        ...withWav.map((cue) => cue.wavPath!),
      ],
      onPublication
        ? (state) =>
            onPublication({
              ...state,
              skippedIndexes: track?.skippedIndexes || [],
            })
        : undefined,
    );
    track = await buildDubTrack(session, {
      config,
      overflow: config.overflow,
      overlapMode: config.overlapMode,
      signal,
      shiftedSubtitle: config.exportShiftedSubtitle
        ? {
            path: path.join(output.directory, 'aligned.srt'),
            mode: 'always',
          }
        : undefined,
    });
    const trackPath = track.trackPath;

    emit('mux', 60);
    if (config.output === 'audioOnly') {
      if ((config.audioFormat ?? 'wav') === 'mp3') {
        await encodeMp3(trackPath, output.staged, signal);
      } else {
        await fs.promises.copyFile(trackPath, output.staged);
      }
    } else {
      // 视频形态（替换/混音/双轨）经统一合成队列执行（全局单编码槽，可排队）；
      // 会话取消联动取消对应合成作业。
      const audioMode =
        config.output === 'replaceTrack'
          ? ('replace' as const)
          : config.output === 'mixTrack'
            ? ('mix' as const)
            : ('addTrack' as const);
      const { jobId, done } = enqueueCompose(
        {
          videoPath: session.videoPath!,
          outputPath: output.staged,
          subtitle: { mode: 'none' },
          audio: { mode: audioMode, trackPath },
        },
        'dubbingExport',
      );
      const onAbort = () => cancelComposeJob(jobId);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const composeResult = await done;
        if (composeResult.cancelled || signal.aborted) {
          throw new TaskCancelledError();
        }
        if (!composeResult.success || !composeResult.outputPath) {
          throw new Error(composeResult.error || '合成音轨封装失败');
        }
        if (composeResult.outputPath !== output.staged)
          await fs.promises.copyFile(composeResult.outputPath, output.staged);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }

    const outputPath = await output.publish(
      signal,
      track.shiftedSubtitlePath
        ? [{ stagedPath: track.shiftedSubtitlePath, suffix: '.dubbed.srt' }]
        : [],
    );
    const shiftedSubtitlePath = track.shiftedSubtitlePath
      ? path.join(
          path.dirname(outputPath),
          path.parse(outputPath).name + '.dubbed.srt',
        )
      : undefined;
    emit('done', 100);
    return {
      outputPath,
      shiftedSubtitlePath,
      skippedIndexes: track.skippedIndexes,
      plan: track.plan,
    };
  } finally {
    try {
      output?.cleanup();
      if (track)
        fs.rmSync(path.dirname(track.trackPath), {
          recursive: true,
          force: true,
        });
    } finally {
      session.running = false;
      session.abort = null;
      flushDubbingSession(session);
    }
  }
}

/** 输出路径：视频旁 `<name>-dubbed.<ext>`；纯音频跟字幕旁。 */
function resolveOutputPath(
  session: DubbingSession,
  config: DubbingConfig,
): string {
  const baseSource =
    config.output === 'audioOnly' || !session.videoPath
      ? session.subtitlePath
      : session.videoPath;
  const dir = path.dirname(baseSource);
  const stem = path.basename(baseSource, path.extname(baseSource));
  const ext =
    config.output === 'audioOnly'
      ? (config.audioFormat ?? 'wav') === 'mp3'
        ? '.mp3'
        : '.wav'
      : config.output === 'addTrack'
        ? '.mkv'
        : path.extname(session.videoPath!) || '.mp4';
  return path.join(dir, `${stem}-dubbed${ext}`);
}

/** 试听合成：临时 wav（不进会话），返回路径供 media:// 播放。 */
export async function previewVoice(
  engine: DubbingEngineSelection,
  voiceId: string,
  text: string | undefined,
  opts?: {
    cloneQuality?: 'standard' | 'high';
    language?: string;
    subtitleLanguage?: string;
    detectedLanguage?: string;
    speakerSettings?: DubbingSpeakerSettings;
    signal?: AbortSignal;
    maxDurationMs?: number;
    onPcm?: (pcm: Uint8Array, sampleRate: number) => void;
  },
): Promise<{ wavPath: string; durationMs: number }> {
  const adapter = buildEngineAdapter(engine, opts);
  if (opts?.speakerSettings) assertDubbingSpeakerSettings(opts.speakerSettings);
  const language = resolvedDubbingLanguage(
    { engine, language: opts?.language },
    voiceId,
    {
      subtitleLanguage: opts?.subtitleLanguage,
      detectedLanguage:
        opts?.detectedLanguage ??
        (text ? detectDubbingLanguage(text) : undefined),
    },
  );
  const sample =
    text?.trim() ||
    (ttsBaseLanguage(language) === 'zh'
      ? '你好，项目已经完成了90%。'
      : 'Hello, the project is 90% complete.');
  const outWavPath = path.join(
    ensureTempDir(),
    'dubbing',
    `preview-${randomUUID()}.wav`,
  );
  fs.mkdirSync(path.dirname(outWavPath), { recursive: true });
  const paths = [outWavPath];
  let resultPath: string | undefined;
  let streamed = false;
  try {
    await adapter.synthesize(
      normalizeDubbingSpeechText(sample),
      voiceId,
      1,
      outWavPath,
      opts?.signal,
      language,
      opts?.onPcm
        ? {
            settings: opts.speakerSettings,
            onPcm: (pcm, rate) => {
              streamed = true;
              opts.onPcm!(pcm, rate);
            },
          }
        : undefined,
    );
    let currentPath = outWavPath;
    if (
      !streamed &&
      opts?.speakerSettings &&
      (opts.speakerSettings.speed !== 1 || opts.speakerSettings.pitch !== 0)
    ) {
      const adjusted = outWavPath.replace(/\.wav$/, '-role.wav');
      paths.push(adjusted);
      await applySpeakerSettingsWav(
        outWavPath,
        adjusted,
        opts.speakerSettings,
        opts.signal,
      );
      currentPath = adjusted;
    }
    if (!streamed && opts?.maxDurationMs) {
      const clipped = outWavPath.replace(/\.wav$/, '-clip.wav');
      paths.push(clipped);
      await trimPreviewWav(
        currentPath,
        clipped,
        Math.min(3000, Math.max(100, opts.maxDurationMs)),
        opts.signal,
      );
      currentPath = clipped;
    }
    if (opts?.signal?.aborted) throw new TaskCancelledError();
    const durationMs = wavDurationMs(currentPath);
    resultPath = currentPath;
    return { wavPath: currentPath, durationMs };
  } finally {
    for (const file of paths) {
      if (file === resultPath) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        /* only this preview's files */
      }
    }
  }
}

/** 取消会话当前批量/导出。 */
export function cancelDubbing(session: DubbingSession): boolean {
  if (!session.abort) return false;
  session.abort.abort();
  return true;
}

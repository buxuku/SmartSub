import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { logMessage } from '../storeManager';
import { ensureTempDir } from '../fileUtils';
import { TaskCancelledError } from '../taskContext';
import {
  getSessionDir,
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
import {
  computeSlots,
  estimateDurationMs,
  createCalibration,
  updateCalibration,
  calibratedEstimate,
  decideSpeedAction,
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
  assembleTrack,
  amixWavs,
  encodeMp3,
  probeMediaDurationMs,
} from './audioPipeline';
import { enqueueCompose, cancelComposeJob } from '../compose/composeQueue';
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
import { getTtsCapabilities } from '../../../types/ttsProvider';
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
  status: DubbingCueStatus;
  overlap: boolean;
  /** 实测最终时长（ms，含一切变速后）。 */
  finalMs?: number;
  /** 对齐层施加的综合额外倍率（不含用户整体语速）。 */
  appliedSpeed?: number;
  wavPath?: string;
  error?: string;
  /** 过长行的所需综合倍率（提示用）。 */
  requiredFactor?: number;
  action: AlignmentSpeedAction;
}

export interface DubbingSession {
  id: string;
  subtitlePath: string;
  /** 字幕内容 hash（会话持久化恢复的合法性依据） */
  subtitleHash: string;
  videoPath?: string;
  mediaDurationMs: number;
  cues: SessionCue[];
  workDir: string;
  running: boolean;
  abort: AbortController | null;
  calibration: RateCalibration;
  lastConfig?: DubbingConfig;
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
  return sessions.get(id);
}

/** 会话 → 持久化元数据（wav 路径折算为相对会话目录的文件名） */
function toSessionMeta(session: DubbingSession): DubbingSessionMeta {
  return {
    version: 1,
    sessionId: session.id,
    subtitlePath: session.subtitlePath,
    subtitleHash: session.subtitleHash,
    videoPath: session.videoPath,
    mediaDurationMs: session.mediaDurationMs,
    updatedAt: Date.now(),
    configSnapshot: session.lastConfig,
    // 校准随会话落盘：半成品会话重开后续行的语速预估不从零开始
    calibration: session.calibration,
    cues: session.cues.map((c) => ({
      index: c.index,
      startMs: c.startMs,
      endMs: c.endMs,
      text: c.text,
      voiceId: c.voiceId,
      // 中断快照：synthesizing 落盘为 pending（重开后继续合成）
      status: c.status === 'synthesizing' ? 'pending' : c.status,
      overlap: c.overlap,
      finalMs: c.finalMs,
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
): Promise<DubbingSession> {
  const content = fs.readFileSync(subtitlePath, 'utf-8');
  const format = detectSubtitleFormat(subtitlePath);
  const parsed = parseSubtitleCues(content, format);
  if (parsed.length === 0) {
    throw new Error('字幕文件为空或无法解析');
  }
  const mediaDurationMs = videoPath ? await probeMediaDurationMs(videoPath) : 0;

  const id = randomUUID();
  // 持久会话目录（应用数据目录下）：dispose 不删除，重开可恢复
  const workDir = getSessionDir(id);
  fs.mkdirSync(workDir, { recursive: true });

  const session: DubbingSession = {
    id,
    subtitlePath,
    subtitleHash: hashSubtitleContent(content),
    videoPath,
    mediaDurationMs,
    workDir,
    running: false,
    abort: null,
    calibration: createCalibration(),
    cues: parsed.map((c: SubtitleCue, index: number) => ({
      index,
      startMs: c.startMs,
      endMs: c.endMs,
      text: c.text.replace(/\n+/g, ' ').trim(),
      status: 'pending' as DubbingCueStatus,
      overlap: false,
      action: { type: 'none' as const },
    })),
  };
  // 重叠检测前置到加载期（UI 立即可见告警）。
  const slots = computeSlots(session.cues, {
    mediaDurationMs: mediaDurationMs || undefined,
  });
  for (const slot of slots) {
    if (slot.overlapNext) session.cues[slot.index].overlap = true;
  }
  sessions.set(id, session);
  flushDubbingSession(session);
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
export function restoreDubbingSession(sessionId: string): RestoreSessionResult {
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
    cues: meta.cues.map((persisted) => {
      const resolved = resolvePersistedCue(meta.sessionId, persisted);
      return {
        index: resolved.index,
        startMs: resolved.startMs,
        endMs: resolved.endMs,
        text: resolved.text,
        voiceId: resolved.voiceId,
        status: resolved.status,
        overlap: resolved.overlap,
        finalMs: resolved.finalMs,
        appliedSpeed: resolved.appliedSpeed,
        requiredFactor: resolved.requiredFactor,
        wavPath: resolved.wavPath,
        error: resolved.error,
        action: resolved.action,
      };
    }),
  };
  sessions.set(session.id, session);
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
  // 从未产出任何行级结果的会话没有可恢复价值：直接清理目录，防止空目录堆积
  const hasArtifacts = session.cues.some(
    (c) => c.wavPath || c.status === 'failed',
  );
  if (hasArtifacts) {
    flushDubbingSession(session);
  } else {
    session.disposed = true;
    deleteSessionData(id);
  }
}

/** 彻底删除会话数据（工作项删除联动/用户确认重建）。 */
export function deleteDubbingSessionData(id: string): void {
  const session = sessions.get(id);
  if (session) {
    // 先置 disposed 再 abort：进行中批量被中断后，其 finally/行级落盘
    // 全部变 no-op，避免把刚删除的会话目录重新写回
    session.disposed = true;
    session.abort?.abort();
    sessions.delete(id);
  }
  deleteSessionData(id);
}

// ── 引擎适配（本地 worker / 云端 service 收敛为统一 synth 函数）──────────────

interface EngineAdapter {
  speedControl: 'native' | 'ssml' | 'none';
  canResynthesize: boolean;
  concurrency: number;
  synthesize: (
    text: string,
    voiceId: string,
    speed: number,
    outWavPath: string,
    signal?: AbortSignal,
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
        speedControl: 'none',
        canResynthesize: false, // 重合成不能改语速 → 复测直接 atempo
        concurrency: localConcurrency, // 进程池并行（每路一份模型内存）
        synthesize: async (text, voiceId, speed, outWavPath, signal) => {
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
              sid: 0,
              speed,
              outWavPath,
              generationConfig: {
                refWavPath: voice.refWavPath,
                refText: voice.refText || '',
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
      speedControl: 'native',
      canResynthesize: true, // 本地合成免费 → 复测走重合成
      concurrency: localConcurrency, // 进程池并行（每路一份模型内存）
      synthesize: async (text, voiceId, speed, outWavPath, signal) =>
        runSynthesize(
          {
            model,
            text,
            sid: resolveTtsVoiceSid(spec, voiceId),
            speed,
            outWavPath,
          },
          signal,
        ),
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
  gate.setLimits(concurrency, 0);
  return {
    speedControl: caps.speedControl,
    canResynthesize: false, // 云端重合成花钱 → 复测走 atempo
    concurrency,
    synthesize: async (text, voiceId, speed, outWavPath, signal) => {
      const release = await gate.acquire(signal);
      try {
        const r = await synthesizeSegment(provider, {
          text,
          voice: voiceId,
          speed,
          outWavPath,
          signal,
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
): Promise<void> {
  const globalSpeed =
    Number.isFinite(config.globalSpeed) && config.globalSpeed > 0
      ? config.globalSpeed
      : 1;
  const voiceId = cue.voiceId || config.voice;
  const wavPath = path.join(session.workDir, `cue-${cue.index}.wav`);

  if (!cue.text) {
    // 空行：静音占位，无需合成。
    cue.status = 'done';
    cue.finalMs = 0;
    cue.appliedSpeed = 1;
    cue.wavPath = undefined;
    cue.action = { type: 'none' };
    return;
  }

  // 第 1 层：预估（含校准与整体语速）→ speed 预控制。
  const est = calibratedEstimate(
    estimateDurationMs(cue.text),
    session.calibration,
  );
  const estAtGlobal = Math.round(est / globalSpeed);
  const decision = decideSpeedAction(
    estAtGlobal,
    slot.slotMs,
    adapter.speedControl,
  );

  let appliedExtra = decision.preSpeed;
  let synthSpeed = globalSpeed * decision.preSpeed;
  let r = await adapter.synthesize(
    cue.text,
    voiceId,
    synthSpeed,
    wavPath,
    signal,
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
  let action: AlignmentSpeedAction =
    decision.preSpeed > 1
      ? { type: 'preSpeed', speed: decision.preSpeed }
      : { type: 'none' };
  let overlong = false;
  let requiredFactor: number | undefined;
  let resynthesized = false;

  // 第 2 层复测环：重合成至多一次，其后 atempo 兜底；超红线判过长。
  for (;;) {
    if (signal?.aborted) throw new TaskCancelledError();
    const measured = wavDurationMs(currentWav);
    const recheck = recheckAfterSynthesis(measured, slot.slotMs, appliedExtra, {
      canResynthesize: adapter.canResynthesize,
      alreadyResynthesized: resynthesized,
    });
    if (recheck.type === 'fit') break;
    if (recheck.type === 'overlong') {
      overlong = true;
      requiredFactor = recheck.requiredFactor;
      break;
    }
    if (recheck.type === 'resynthesize') {
      synthSpeed = globalSpeed * recheck.speed;
      r = await adapter.synthesize(
        cue.text,
        voiceId,
        synthSpeed,
        wavPath,
        signal,
      );
      appliedExtra = recheck.speed;
      action = { type: 'preSpeed', speed: recheck.speed };
      resynthesized = true;
      currentWav = wavPath;
      continue;
    }
    // atempo：对已产出 wav 后处理变速。
    const tempoPath = path.join(session.workDir, `cue-${cue.index}-atempo.wav`);
    await atempoWav(currentWav, tempoPath, recheck.factor, signal);
    currentWav = tempoPath;
    appliedExtra *= recheck.factor;
    action = { type: 'atempo', factor: recheck.factor };
    break;
  }

  cue.wavPath = currentWav;
  cue.finalMs = wavDurationMs(currentWav);
  cue.appliedSpeed = appliedExtra;
  cue.action = action;
  cue.requiredFactor = requiredFactor;
  cue.status = overlong ? 'overlong' : 'done';
  cue.error = undefined;
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
  opts?: { force?: boolean },
): Promise<BatchResult> {
  if (session.running) throw new Error('该会话已有合成任务进行中');
  const adapter = buildEngineAdapter(config.engine, {
    cloneQuality: config.cloneQuality,
    localConcurrency: config.localConcurrency,
  });
  session.running = true;
  session.abort = new AbortController();
  session.lastConfig = config;
  const signal = session.abort.signal;

  const slots = computeSlots(session.cues, {
    mediaDurationMs: session.mediaDurationMs || undefined,
  });
  const slotByIndex = new Map(slots.map((s) => [s.index, s]));

  const targets = opts?.force
    ? session.cues
    : session.cues.filter(
        (c) => c.status !== 'done' && c.status !== 'accepted',
      );
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
      );
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
      (c) => c.status === 'done' || c.status === 'accepted',
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
  overrides: { text?: string; voiceId?: string },
  config: DubbingConfig,
): Promise<SessionCue> {
  const cue = session.cues.find((c) => c.index === index);
  if (!cue) throw new Error(`行不存在：${index}`);
  if (session.running) throw new Error('批量合成进行中，无法单行重生成');

  const adapter = buildEngineAdapter(config.engine, {
    cloneQuality: config.cloneQuality,
  });
  if (overrides.text !== undefined) cue.text = overrides.text.trim();
  if (overrides.voiceId !== undefined) {
    // '' = 清除行级覆盖，回落全局 voice。
    cue.voiceId = overrides.voiceId || undefined;
  }
  session.lastConfig = config;

  const slots = computeSlots(session.cues, {
    mediaDurationMs: session.mediaDurationMs || undefined,
  });
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
    );
  } catch (e) {
    if (e instanceof TaskCancelledError) {
      cue.status = 'pending';
      throw e;
    }
    cue.status = 'failed';
    cue.error = e instanceof Error ? e.message : String(e);
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
  const cue = session.cues.find((c) => c.index === index);
  if (!cue) throw new Error(`行不存在：${index}`);
  cue.voiceId = voiceId || undefined;
  persistDubbingSession(session);
  return cue;
}

/** 过长行「接受变速」：按所需残余倍率 atempo 对齐进槽位，状态转 accepted。 */
export async function acceptOverlongCue(
  session: DubbingSession,
  index: number,
): Promise<SessionCue> {
  const cue = session.cues.find((c) => c.index === index);
  if (!cue) throw new Error(`行不存在：${index}`);
  if (cue.status !== 'overlong' || !cue.wavPath) {
    throw new Error('该行不是待处理的过长行');
  }
  const slots = computeSlots(session.cues, {
    mediaDurationMs: session.mediaDurationMs || undefined,
  });
  const slot = slots.find((s) => s.index === index)!;
  const measured = wavDurationMs(cue.wavPath);
  const factor = slot.slotMs > 0 ? measured / slot.slotMs : 1;
  if (factor > 1.001) {
    const outPath = path.join(session.workDir, `cue-${index}-accepted.wav`);
    await atempoWav(cue.wavPath, outPath, factor);
    cue.wavPath = outPath;
    cue.finalMs = wavDurationMs(outPath);
    cue.appliedSpeed = (cue.appliedSpeed ?? 1) * factor;
    cue.action = { type: 'atempo', factor };
  }
  cue.status = 'accepted';
  persistDubbingSession(session);
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
  opts: {
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
      path: string;
      mode: 'always' | 'ifShifted';
      displayTextByIndex?: Map<number, string>;
    };
  },
): Promise<DubTrackResult> {
  const withWav = session.cues.filter((c) => c.wavPath && c.finalMs);
  if (withWav.length === 0) {
    throw new Error('没有可导出的配音行，请先开始配音');
  }
  const overflow = opts.overflow ?? 'truncate';
  const overlapMode = opts.overlapMode ?? 'shift';
  const signal = opts.signal;
  const plan = buildSessionPlan(session, overflow, overlapMode);
  const wavByIndex = new Map(session.cues.map((c) => [c.index, c.wavPath]));

  const trackPath = path.join(session.workDir, 'dub-track.wav');
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
      const lanePath = path.join(session.workDir, `dub-lane-${lane}.wav`);
      await assembleTrack(laneSegments.get(lane)!, lanePath, {
        totalDurationMs,
        signal,
      });
      laneTracks.push(lanePath);
    }
    await amixWavs(laneTracks, trackPath, signal);
  }

  // 顺延字幕：按规划后的时间轴序列化；ifShifted 模式仅在时间轴实际变化时产出
  let shiftedSubtitlePath: string | undefined;
  if (opts.shiftedSubtitle) {
    const timeline = shiftedTimeline(plan);
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
      shiftedSubtitlePath = opts.shiftedSubtitle.path;
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
): Promise<ExportResult> {
  if (session.running) throw new Error('合成进行中，请先等待或取消');
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

  try {
    emit('concat', 10);
    const outputPath = resolveOutputPath(session, config);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const track = await buildDubTrack(session, {
      overflow: config.overflow,
      overlapMode: config.overlapMode,
      signal,
      shiftedSubtitle: config.exportShiftedSubtitle
        ? {
            path: outputPath.replace(/\.[^.]+$/, '') + '.dubbed.srt',
            mode: 'always',
          }
        : undefined,
    });
    const trackPath = track.trackPath;

    emit('mux', 60);
    if (config.output === 'audioOnly') {
      if ((config.audioFormat ?? 'wav') === 'mp3') {
        await encodeMp3(trackPath, outputPath, signal);
      } else {
        fs.copyFileSync(trackPath, outputPath);
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
          outputPath,
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
        if (!composeResult.success) {
          throw new Error(composeResult.error || '合成音轨封装失败');
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }

    emit('done', 100);
    return {
      outputPath,
      shiftedSubtitlePath: track.shiftedSubtitlePath,
      skippedIndexes: track.skippedIndexes,
      plan: track.plan,
    };
  } finally {
    session.running = false;
    session.abort = null;
    flushDubbingSession(session);
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
  let candidate = path.join(dir, `${stem}-dubbed${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-dubbed-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

/** 试听合成：临时 wav（不进会话），返回路径供 media:// 播放。 */
export async function previewVoice(
  engine: DubbingEngineSelection,
  voiceId: string,
  text: string | undefined,
  opts?: { cloneQuality?: 'standard' | 'high' },
): Promise<{ wavPath: string; durationMs: number }> {
  const adapter = buildEngineAdapter(engine, opts);
  // 克隆音色的默认试听文本按音色语言：ZipVoice 跨语言（参考英文 + 文本中文）
  // 时长预测严重不足，语音被压缩到不可辨——试听必须同语言才反映真实效果。
  let cloneLanguage: 'zh' | 'en' | undefined;
  if (engine.kind === 'local') {
    const { getClonedVoiceById } =
      require('../voiceClone/voiceCloneManager') as typeof import('../voiceClone/voiceCloneManager');
    cloneLanguage = getClonedVoiceById(voiceId)?.language;
  }
  const sample =
    text?.trim() ||
    (cloneLanguage === 'en'
      ? 'Hello, this is a voice preview. Nice to meet you.'
      : cloneLanguage === 'zh'
        ? '你好，这是配音试听。'
        : /^[\x00-\x7F]*$/.test(voiceId) && engine.kind === 'cloud'
          ? '你好，这是配音试听。Hello, this is a voice preview.'
          : '你好，这是配音试听。');
  const outWavPath = path.join(
    ensureTempDir(),
    'dubbing',
    `preview-${Date.now()}.wav`,
  );
  fs.mkdirSync(path.dirname(outWavPath), { recursive: true });
  const r = await adapter.synthesize(sample, voiceId, 1, outWavPath);
  return { wavPath: outWavPath, durationMs: r.durationMs };
}

/** 取消会话当前批量/导出。 */
export function cancelDubbing(session: DubbingSession): boolean {
  if (!session.abort) return false;
  session.abort.abort();
  return true;
}

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { logMessage } from '../storeManager';
import { ensureTempDir } from '../fileUtils';
import { TaskCancelledError } from '../taskContext';
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
  replaceAudioTrack,
  duckMixIntoVideo,
  addAudioTrack,
  probeMediaDurationMs,
} from './audioPipeline';
import type {
  AlignmentPlan,
  AlignmentSpeedAction,
  DubbingConfig,
  DubbingCueStatus,
  DubbingEngineSelection,
  DubbingProgressEvent,
  DubbingStage,
} from '../../../types/dubbing';
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
  videoPath?: string;
  mediaDurationMs: number;
  cues: SessionCue[];
  workDir: string;
  running: boolean;
  abort: AbortController | null;
  calibration: RateCalibration;
  lastConfig?: DubbingConfig;
  workItemId?: string;
}

const sessions = new Map<string, DubbingSession>();

export function getDubbingSession(id: string): DubbingSession | undefined {
  return sessions.get(id);
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
  const workDir = path.join(ensureTempDir(), 'dubbing', id);
  fs.mkdirSync(workDir, { recursive: true });

  const session: DubbingSession = {
    id,
    subtitlePath,
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
  return session;
}

export function disposeDubbingSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.abort?.abort();
  sessions.delete(id);
  try {
    fs.rmSync(session.workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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

function buildEngineAdapter(engine: DubbingEngineSelection): EngineAdapter {
  if (engine.kind === 'local') {
    const modelId = engine.modelId as TtsModelId;
    const spec = TTS_MODELS[modelId];
    if (!spec) throw new Error(`未知本地 TTS 模型：${engine.modelId}`);
    if (!isTtsModelInstalled(modelId)) {
      throw new Error(
        `本地模型 ${spec.displayName} 未安装，请先在「引擎与模型」页下载`,
      );
    }
    const model = getTtsModelRequest(modelId);
    const runtime = getSherpaTtsRuntime();
    return {
      speedControl: 'native',
      canResynthesize: true, // 本地合成免费 → 复测走重合成
      concurrency: 1, // worker 单实例串行
      synthesize: async (text, voiceId, speed, outWavPath, signal) => {
        if (signal?.aborted) throw new TaskCancelledError();
        const { id, result } = runtime.synthesize({
          model,
          text,
          sid: resolveTtsVoiceSid(spec, voiceId),
          speed,
          outWavPath,
        });
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
  const adapter = buildEngineAdapter(config.engine);
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

  const adapter = buildEngineAdapter(config.engine);
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

/** 导出：槽位拼接 → 背景音/输出形态 → 可选顺延字幕。 */
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
  const signal = session.abort.signal;
  const emit = (stage: DubbingStage, percent: number) =>
    onProgress({ taskId: session.id, stage, percent });

  try {
    const overflow = config.overflow ?? 'truncate';
    const overlapMode = config.overlapMode ?? 'shift';
    const plan = buildSessionPlan(session, overflow, overlapMode);
    const wavByIndex = new Map(session.cues.map((c) => [c.index, c.wavPath]));

    emit('concat', 10);
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

    emit('mux', 60);
    const outputPath = resolveOutputPath(session, config);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (config.output === 'audioOnly') {
      if ((config.audioFormat ?? 'wav') === 'mp3') {
        await encodeMp3(trackPath, outputPath, signal);
      } else {
        fs.copyFileSync(trackPath, outputPath);
      }
    } else if (config.output === 'replaceTrack') {
      await replaceAudioTrack(
        session.videoPath!,
        trackPath,
        outputPath,
        signal,
      );
    } else if (config.output === 'mixTrack') {
      await duckMixIntoVideo(session.videoPath!, trackPath, outputPath, {
        signal,
      });
    } else {
      await addAudioTrack(session.videoPath!, trackPath, outputPath, signal);
    }

    let shiftedSubtitlePath: string | undefined;
    if (config.exportShiftedSubtitle) {
      const textByIndex = new Map(session.cues.map((c) => [c.index, c.text]));
      const cues: SubtitleCue[] = shiftedTimeline(plan)
        .filter((t) => t.endMs > t.startMs)
        .map((t) => ({
          startMs: t.startMs,
          endMs: t.endMs,
          text: textByIndex.get(t.index) ?? '',
        }));
      shiftedSubtitlePath = outputPath.replace(/\.[^.]+$/, '') + '.dubbed.srt';
      fs.writeFileSync(shiftedSubtitlePath, serializeSubtitleCues(cues, 'srt'));
    }

    emit('done', 100);
    const planned = new Set(plan.items.map((i) => i.index));
    return {
      outputPath,
      shiftedSubtitlePath,
      skippedIndexes: session.cues
        .filter((c) => !planned.has(c.index) || !c.wavPath)
        .map((c) => c.index),
      plan,
    };
  } finally {
    session.running = false;
    session.abort = null;
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
): Promise<{ wavPath: string; durationMs: number }> {
  const adapter = buildEngineAdapter(engine);
  const sample =
    text?.trim() ||
    (/^[\x00-\x7F]*$/.test(voiceId) && engine.kind === 'cloud'
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

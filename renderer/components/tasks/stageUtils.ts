import { isSubtitleFile } from 'lib/utils';
import type { TaskTypeDef } from 'lib/taskTypes';

export type StageKey =
  | 'extractAudio'
  | 'extractSubtitle'
  | 'translateSubtitle'
  | 'dubbing'
  | 'composeVideo';
export type StageStatus = 'pending' | 'loading' | 'done' | 'error';

export interface StageDef {
  key: StageKey;
  /** i18n key inside tasks namespace, e.g. stage.extract */
  labelKey: string;
}

/**
 * 按任务类型 + 输入文件种类推导该文件要经过的阶段。
 * formData 可为任务配置快照（含 dub/compose 附加阶段）——向导任务据此扩列。
 */
export function getFileStages(
  file: any,
  typeDef: TaskTypeDef,
  formData: any,
): StageDef[] {
  const subtitleInput = isSubtitleFile(file?.filePath || '');
  // 配对模式（媒体携带既有字幕）：跳过提取/听写，不在轨道上展示
  const hasProvidedSubtitle = Boolean(file?.providedSubtitlePath);
  const stages: StageDef[] = [];
  if (!subtitleInput && !hasProvidedSubtitle) {
    stages.push({ key: 'extractAudio', labelKey: 'stage.extract' });
    stages.push({ key: 'extractSubtitle', labelKey: 'stage.transcribe' });
  }
  if (typeDef.hasTranslate && formData?.translateProvider !== '-1') {
    stages.push({ key: 'translateSubtitle', labelKey: 'stage.translate' });
  }
  // 附加阶段：配置快照声明，或文件上已有阶段状态（快照缺失时兜底）
  if (formData?.dub || file?.dubbing !== undefined) {
    stages.push({ key: 'dubbing', labelKey: 'stage.dubbing' });
  }
  if (formData?.compose || file?.composeVideo !== undefined) {
    stages.push({ key: 'composeVideo', labelKey: 'stage.compose' });
  }
  return stages;
}

export function getStageStatus(file: any, key: StageKey): StageStatus {
  const value = file?.[key];
  if (value === 'loading') return 'loading';
  if (value === 'done') return 'done';
  if (value === 'error') return 'error';
  return 'pending';
}

// ── 人工检查点（白话：字幕校对 / 配音确认）────────────────────────────────

export type GateKey = 'subtitleGate' | 'dubbingGate';
export type GateStatus = 'pending' | 'review' | 'passed';

export interface GateDef {
  key: GateKey;
  /** i18n key inside tasks namespace */
  labelKey: string;
}

export function getGateStatus(file: any, key: GateKey): GateStatus {
  const value = file?.[key];
  if (value === 'review') return 'review';
  if (value === 'passed') return 'passed';
  return 'pending';
}

/** 任务启用的检查点清单（按配置快照推导） */
export function getFileGates(formData: any): GateDef[] {
  const gates: GateDef[] = [];
  if (
    formData?.gates?.subtitle === 'manual' &&
    (formData?.dub || formData?.compose)
  ) {
    gates.push({ key: 'subtitleGate', labelKey: 'gate.subtitle' });
  }
  if (formData?.dub && formData?.gates?.dubbing === 'manual') {
    gates.push({ key: 'dubbingGate', labelKey: 'gate.dubbing' });
  }
  return gates;
}

/** 轨道条目：阶段方块与检查点菱形交错排列 */
export type RailItem =
  | { kind: 'stage'; stage: StageDef }
  | { kind: 'gate'; gate: GateDef };

/**
 * 文件的完整轨道：字幕校对点插在字幕段之后（配音/合成之前），
 * 配音确认点插在配音阶段之后。
 */
export function getFileRail(
  file: any,
  typeDef: TaskTypeDef,
  formData: any,
): RailItem[] {
  const stages = getFileStages(file, typeDef, formData);
  const gates = getFileGates(formData);
  const subtitleGate = gates.find((g) => g.key === 'subtitleGate');
  const dubbingGate = gates.find((g) => g.key === 'dubbingGate');
  const hasDub = stages.some((s) => s.key === 'dubbing');
  const hasCompose = stages.some((s) => s.key === 'composeVideo');

  const rail: RailItem[] = [];
  for (const stage of stages) {
    // 字幕校对点：字幕段之后（第一个附加阶段之前）
    if (
      subtitleGate &&
      (stage.key === 'dubbing' || (stage.key === 'composeVideo' && !hasDub))
    ) {
      rail.push({ kind: 'gate', gate: subtitleGate });
    }
    // 配音确认点：配音之后、合成之前
    if (dubbingGate && stage.key === 'composeVideo' && hasDub) {
      rail.push({ kind: 'gate', gate: dubbingGate });
    }
    rail.push({ kind: 'stage', stage });
  }
  // 仅配音无合成：配音确认点收尾
  if (dubbingGate && hasDub && !hasCompose) {
    rail.push({ kind: 'gate', gate: dubbingGate });
  }
  return rail;
}

/** 文件当前停靠的检查点（无停靠返回 null） */
export function getDockedGate(file: any, formData: any): GateDef | null {
  for (const gate of getFileGates(formData)) {
    if (getGateStatus(file, gate.key) === 'review') return gate;
  }
  return null;
}

/** 文件整体进度（0-100）：完成阶段均摊 + 当前阶段按其进度折算 */
export function getFilePercent(file: any, stages: StageDef[]): number {
  if (!stages.length) return 0;
  let total = 0;
  for (const stage of stages) {
    const status = getStageStatus(file, stage.key);
    if (status === 'done') {
      total += 1;
    } else if (status === 'loading' || status === 'error') {
      const progress = Number(file?.[`${stage.key}Progress`] || 0);
      total += Math.min(Math.max(progress, 0), 100) / 100;
    }
  }
  return Math.round((total / stages.length) * 100);
}

export function isFileTerminal(file: any, stages: StageDef[]): boolean {
  if (!stages.length) return false;
  return stages.every((s) => {
    const status = getStageStatus(file, s.key);
    return status === 'done' || status === 'error';
  });
}

export function isFileDone(file: any, stages: StageDef[]): boolean {
  if (!stages.length) return false;
  return stages.every((s) => getStageStatus(file, s.key) === 'done');
}

export function hasFileError(file: any, stages: StageDef[]): boolean {
  return stages.some((s) => getStageStatus(file, s.key) === 'error');
}

export function getFileError(file: any, stages: StageDef[]): string {
  for (const stage of stages) {
    if (getStageStatus(file, stage.key) === 'error') {
      return file?.[`${stage.key}Error`] || '';
    }
  }
  return '';
}

/** 校对解锁条件（沿用旧 TaskList 逻辑） */
export function isProofreadReady(file: any, typeDef: TaskTypeDef): boolean {
  if (typeDef.taskType === 'generateOnly') {
    return file?.extractSubtitle === 'done';
  }
  return file?.translateSubtitle === 'done';
}

export type ProofreadUnavailableReason = 'txt';

export function isPlainTextSubtitlePath(filePath?: string): boolean {
  return /\.txt$/i.test(filePath || '');
}

export function getTaskProofreadSourcePath(
  file: any,
  typeDef: TaskTypeDef,
): string {
  const sourcePath =
    file?.srtFile ||
    file?.tempSrtFile ||
    (isSubtitleFile(file?.filePath || '') ? file.filePath : '');

  if (typeDef.taskType === 'generateOnly') {
    return sourcePath;
  }

  return sourcePath;
}

export function getTaskProofreadTargetPath(
  file: any,
  typeDef: TaskTypeDef,
): string {
  if (typeDef.taskType === 'generateOnly') return '';
  return file?.tempTranslatedSrtFile || file?.translatedSrtFile || '';
}

export function getProofreadUnavailableReason(
  file: any,
  typeDef: TaskTypeDef,
): ProofreadUnavailableReason | null {
  if (file?.proofreadDataFile) return null;

  const sourcePath = getTaskProofreadSourcePath(file, typeDef);
  const targetPath = getTaskProofreadTargetPath(file, typeDef);
  if (
    isPlainTextSubtitlePath(sourcePath) ||
    isPlainTextSubtitlePath(targetPath)
  ) {
    return 'txt';
  }
  return null;
}

export function canProofreadFile(file: any, typeDef: TaskTypeDef): boolean {
  return (
    isProofreadReady(file, typeDef) &&
    getProofreadUnavailableReason(file, typeDef) === null
  );
}

/** 打开所在文件夹时优先揭示的产物路径（成品视频 > 配音音频 > 译文 > 源字幕 > 输入文件） */
export function getRevealPath(file: any): string {
  return (
    file?.finalVideoPath ||
    file?.dubbedAudioPath ||
    file?.translatedSrtFile ||
    file?.srtFile ||
    file?.filePath ||
    ''
  );
}

/** 字节数转人类可读（如 1.5 MB）；无效值返回空串 */
export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 秒转 h:mm:ss / m:ss；无效值返回空串 */
export function formatMediaDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

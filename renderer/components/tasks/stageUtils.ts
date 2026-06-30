import { isSubtitleFile } from 'lib/utils';
import type { TaskTypeDef } from 'lib/taskTypes';

export type StageKey = 'extractAudio' | 'extractSubtitle' | 'translateSubtitle';
export type StageStatus = 'pending' | 'loading' | 'done' | 'error';

export interface StageDef {
  key: StageKey;
  /** i18n key inside tasks namespace, e.g. stage.extract */
  labelKey: string;
}

/** 按任务类型 + 输入文件种类推导该文件要经过的阶段 */
export function getFileStages(
  file: any,
  typeDef: TaskTypeDef,
  formData: any,
): StageDef[] {
  const subtitleInput = isSubtitleFile(file?.filePath || '');
  const stages: StageDef[] = [];
  if (!subtitleInput) {
    stages.push({ key: 'extractAudio', labelKey: 'stage.extract' });
    stages.push({ key: 'extractSubtitle', labelKey: 'stage.transcribe' });
  }
  if (typeDef.hasTranslate && formData?.translateProvider !== '-1') {
    stages.push({ key: 'translateSubtitle', labelKey: 'stage.translate' });
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

/** 打开所在文件夹时优先揭示的产物路径 */
export function getRevealPath(file: any): string {
  return file?.translatedSrtFile || file?.srtFile || file?.filePath || '';
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
